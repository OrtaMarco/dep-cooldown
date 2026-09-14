import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAudit, parseIsoTimestamp, selectEntries } from './audit.js';
import { detectAndParse, NoLockfileError } from './lockfiles/index.js';
import { createRegistryClient } from './registry/client.js';
import { diskCache, nullCache, cacheDir, clearCache } from './registry/cache.js';
import { redactRegistryUrl, resolveRegistry } from './registry/npmrc.js';
import { ALL_MANAGERS, renderConfig } from './report/config.js';
import { pickPalette } from './report/color.js';
import { escapeControl, escapeControlKeepNewlines } from './report/sanitize.js';
import { renderTable } from './report/table.js';
import type { Manager } from './types.js';

/** Every audited version is at least `--min-age` days old. */
const EXIT_OK = 0;
/** At least one version is younger than `--min-age`. Wins over everything else. */
const EXIT_YOUNG = 1;
/** Usage or tool error: nothing trustworthy was concluded. */
const EXIT_ERROR = 2;
/** Nothing is young, but some versions could not be checked. `--allow-unknown` makes it 0. */
const EXIT_UNKNOWN = 3;

function version(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `dep-cooldown - audit the dependency cooldown of a JavaScript project

Usage
  npx dep-cooldown [options]

Reads the project's lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock or
bun.lock), asks the registry when every resolved version was published, and
reports which ones a cooldown would have blocked.

Options
  --min-age <days>      Flag versions younger than this, in days: a plain
                        decimal such as 7 or 0.5. Default: 7.
                        Exits 1 when any package is flagged, for CI.
  --allow-unknown       Exit 0 instead of 3 when nothing is flagged but some
                        versions could not be checked (registry errors,
                        --offline cache misses, missing or unreadable dates).
  --as-of <date>        Measure ages against an ISO 8601 date instead of now,
                        to answer "what would a cooldown have blocked the day I
                        installed this?": 2026-09-01, or with time and zone,
                        2026-09-01T16:12:01Z or 2026-09-01T16:12:01+02:00.
                        Defaults to now; the report suggests your lockfile's
                        own mtime.
  --only-direct         Only packages listed in package.json.
  --prod                Skip dependencies the lockfile marks development-only.
  --top <n>             Show at most n rows, a whole number >= 1 (they are
                        sorted youngest first).
  --all                 List every package, not just the ones that need action,
                        and every skipped lockfile entry.
  --json                Machine-readable output. Never coloured.
  --config <target>     Print the paste-ready cooldown config for npm, pnpm,
                        yarn, bun or all, using --min-age. Does not audit.
  --offline             Never touch the network; use the cache and say what is
                        missing.
  --no-cache            Ignore and do not write the on-disk cache.
  --clear-cache         Delete the cache directory and exit.
  --registry <url>      Override the registry. Otherwise .npmrc is honoured.
  --cwd <dir>           Run against another directory.
  --lockfile <name>     Force a specific lockfile name instead of detecting.
  --concurrency <n>     Parallel registry requests, a whole number >= 1.
                        Default: 8.
  --no-color            Disable colour. Colour is off already when not a TTY.
  -h, --help            This text.
  -v, --version         Print the version.

Exit codes
  0  Every audited version is at least --min-age days old. Lockfile entries
     with no registry date (git, file:, link:, workspaces) are listed as
     skipped, not checked.
  1  At least one version is younger than --min-age, or dated after --as-of.
  2  Usage or tool error: a bad flag, no readable lockfile, or --only-direct /
     --prod leaving nothing to audit.
  3  Nothing is younger than --min-age, but some versions could not be
     checked. --allow-unknown turns this into 0.

Cache: ${escapeControl(cacheDir())}

A cooldown buys you time against a compromised *publish*. It does nothing
against a compromised build runner, a malicious postinstall script, or a
version that stays live longer than your threshold. See the README.
`;

function fail(message: string): never {
  process.stderr.write(`dep-cooldown: ${escapeControlKeepNewlines(message)}\n`);
  process.exit(EXIT_ERROR);
}

const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const WHOLE_RE = /^\d+$/;

/** A plain non-negative decimal: no empty string, exponent, hex, sign or spaces. */
function parseDecimal(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!DECIMAL_RE.test(raw) || !Number.isFinite(n)) {
    fail(`${flag} expects a non-negative number such as 7 or 0.5, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** A whole number >= 1. */
function parseCount(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!WHOLE_RE.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    fail(`${flag} expects a whole number >= 1, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        'min-age': { type: 'string' },
        'allow-unknown': { type: 'boolean', default: false },
        'as-of': { type: 'string' },
        'only-direct': { type: 'boolean', default: false },
        prod: { type: 'boolean', default: false },
        top: { type: 'string' },
        all: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        config: { type: 'string' },
        offline: { type: 'boolean', default: false },
        'no-cache': { type: 'boolean', default: false },
        'clear-cache': { type: 'boolean', default: false },
        registry: { type: 'string' },
        cwd: { type: 'string' },
        lockfile: { type: 'string' },
        concurrency: { type: 'string' },
        'no-color': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\nRun --help for usage.`);
  }

  const flags = parsed.values;

  if (flags.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (flags.version) {
    process.stdout.write(`${version()}\n`);
    return EXIT_OK;
  }
  if (flags['clear-cache']) {
    const dir = escapeControl(cacheDir());
    const { removed, kept, removedDir } = await clearCache();
    process.stdout.write(
      removedDir
        ? `removed ${dir} (${removed} cache file(s))\n`
        : `removed ${removed} cache file(s) from ${dir}` +
            (kept > 0 ? `; kept ${kept} file(s) that are not dep-cooldown's\n` : '\n'),
    );
    return EXIT_OK;
  }

  const minAge = parseDecimal(flags['min-age'], '--min-age', 7);

  if (flags.config !== undefined) {
    const target = flags.config as Manager | 'all';
    if (target !== 'all' && !ALL_MANAGERS.includes(target)) {
      fail(`--config expects one of ${[...ALL_MANAGERS, 'all'].join(', ')}, got "${flags.config}"`);
    }
    process.stdout.write(renderConfig(target, minAge));
    return EXIT_OK;
  }

  // Validate every flag before touching the disk or the network.
  const cwd = resolve(flags.cwd ?? process.cwd());
  const concurrency = parseCount(flags.concurrency, '--concurrency', 8);
  const top = parseCount(flags.top, '--top', 0) || undefined;

  let asOf: Date | undefined;
  const asOfExplicit = flags['as-of'] !== undefined;
  if (asOfExplicit) {
    const ms = parseIsoTimestamp(flags['as-of']);
    if (ms === null) {
      fail(
        `--as-of expects an ISO date (ISO 8601) such as 2026-09-01 or 2026-09-01T16:12:01Z, ` +
          `got ${JSON.stringify(flags['as-of'])}`,
      );
    }
    asOf = new Date(ms);
  }

  let lock;
  try {
    lock = await detectAndParse(cwd, flags.lockfile);
  } catch (err) {
    if (err instanceof NoLockfileError) fail(err.message);
    fail(err instanceof Error ? err.message : String(err));
  }
  // Where a future `lock.warnings` would be printed (stderr, escaped).

  const filters = [flags['only-direct'] ? '--only-direct' : '', flags.prod ? '--prod' : ''].filter(Boolean);
  const selected = selectEntries(lock, { onlyDirect: flags['only-direct'], prodOnly: flags.prod });
  const skipped = lock.skipped ?? [];

  if (lock.entries.length > 0 && selected.length === 0) {
    // Not a verdict: nothing was audited, and --allow-unknown must not turn it into a pass.
    fail(
      `${filters.join(' ')} left nothing to audit: ${lock.path} lists ${lock.entries.length} ` +
        `registry package(s), and none of them matches.`,
    );
  }
  const external = skipped.filter((s) => s.reason !== 'workspace' && s.reason !== 'link');
  if (lock.entries.length === 0 && external.length > 0) {
    fail(
      `${lock.path} has nothing to audit: its ${external.length} dependenc${external.length === 1 ? 'y has' : 'ies have'} ` +
        `no registry publish date (git, file:, tarball…). Nothing was checked.`,
    );
  }

  const registryConfig = resolveRegistry(cwd, flags.registry);
  const palette = pickPalette({ noColor: flags['no-color'], stream: process.stdout });
  const interactive = Boolean(process.stdout.isTTY) && !flags.json;

  // Unverifiable entries are reported without a lookup, and filtered-out
  // entries are not looked up at all.
  const names = [...new Set(selected.filter((e) => !e.unverifiable).map((e) => e.name))];
  const client = createRegistryClient({
    config: registryConfig,
    cache: flags['no-cache'] ? nullCache : diskCache(),
    offline: flags.offline,
    concurrency,
    onProgress: interactive
      ? (done, total) => {
          process.stderr.write(`\rresolving ${done}/${total} packages…`);
          if (done === total) process.stderr.write('\r\u001B[K');
        }
      : undefined,
  });

  const meta = names.length > 0 ? await client.fetchAll(names) : new Map();

  const result = buildAudit(lock, meta, {
    minAgeDays: minAge,
    asOf,
    asOfExplicit,
    onlyDirect: flags['only-direct'],
    prodOnly: flags.prod,
    // Requests go to the expanded URL; the report only ever shows it redacted,
    // in the table and in --json alike.
    registry: redactRegistryUrl(registryConfig.default),
    offline: flags.offline,
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderTable(result, { palette, top, all: flags.all, filters }));
    if (result.totals.unknown > 0 && flags.offline) {
      process.stderr.write(
        `${result.totals.unknown} package(s) are not in the cache; run once without --offline.\n`,
      );
    }
  }

  const { young, unknown } = result.totals;
  if (young > 0) return EXIT_YOUNG;
  if (unknown > 0 && !flags['allow-unknown']) {
    process.stderr.write(
      `dep-cooldown: exit 3 - nothing is younger than ${minAge}d, but ${unknown} package ` +
        `version(s) could not be checked (see the error on each); --allow-unknown accepts that.\n`,
    );
    return EXIT_UNKNOWN;
  }
  return EXIT_OK;
}

/** Runs the CLI and sets the exit code. What `bin.js` calls, unconditionally. */
export function run(argv?: string[]): void {
  main(argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`dep-cooldown: ${escapeControlKeepNewlines(detail)}\n`);
      process.exitCode = EXIT_ERROR;
    },
  );
}

/**
 * `node dist/cli.js` keeps working (CI runs it). Compared through realpath on
 * both sides, so a symlink or a `#` in the path cannot make it a silent no-op;
 * the published bin is `dist/bin.js`, which does not depend on this check.
 */
function invokedAsScript(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) run();
