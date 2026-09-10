#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAudit } from './audit.js';
import { detectAndParse, NoLockfileError } from './lockfiles/index.js';
import { createRegistryClient } from './registry/client.js';
import { diskCache, nullCache, cacheDir, clearCache } from './registry/cache.js';
import { resolveRegistry } from './registry/npmrc.js';
import { ALL_MANAGERS, renderConfig } from './report/config.js';
import { pickPalette } from './report/color.js';
import { renderTable } from './report/table.js';
import type { Manager } from './types.js';

const EXIT_OK = 0;
const EXIT_YOUNG = 1;
const EXIT_ERROR = 2;

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
  --min-age <days>      Flag versions younger than this. Default: 7.
                        Exits 1 when any package is flagged, for CI.
  --as-of <date>        Measure ages against an ISO date instead of today, to
                        answer "what would a cooldown have blocked the day I
                        installed this?". Defaults to now; the report suggests
                        your lockfile's own mtime.
  --only-direct         Only packages listed in package.json.
  --prod                Skip dependencies the lockfile marks development-only.
  --top <n>             Show at most n rows (they are sorted youngest first).
  --all                 List every package, not just the ones that need action.
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
  --concurrency <n>     Parallel registry requests. Default: 8.
  --no-color            Disable colour. Colour is off already when not a TTY.
  -h, --help            This text.
  -v, --version         Print the version.

Cache: ${cacheDir()}

A cooldown buys you time against a compromised *publish*. It does nothing
against a compromised build runner, a malicious postinstall script, or a
version that stays live longer than your threshold. See the README.
`;

function fail(message: string): never {
  process.stderr.write(`dep-cooldown: ${message}\n`);
  process.exit(EXIT_ERROR);
}

function parseNumber(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(`${flag} expects a non-negative number, got "${raw}"`);
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
    await clearCache();
    process.stdout.write(`removed ${cacheDir()}\n`);
    return EXIT_OK;
  }

  const minAge = parseNumber(flags['min-age'], '--min-age', 7);

  if (flags.config !== undefined) {
    const target = flags.config as Manager | 'all';
    if (target !== 'all' && !ALL_MANAGERS.includes(target)) {
      fail(`--config expects one of ${[...ALL_MANAGERS, 'all'].join(', ')}, got "${flags.config}"`);
    }
    process.stdout.write(renderConfig(target, minAge));
    return EXIT_OK;
  }

  const cwd = resolve(flags.cwd ?? process.cwd());
  const concurrency = parseNumber(flags.concurrency, '--concurrency', 8) || 8;

  let asOf: Date | undefined;
  const asOfExplicit = typeof flags['as-of'] === 'string' && flags['as-of'].length > 0;
  if (asOfExplicit) {
    const parsedDate = new Date(flags['as-of'] as string);
    if (Number.isNaN(parsedDate.getTime())) {
      fail(`--as-of expects an ISO date such as 2026-09-01, got "${flags['as-of']}"`);
    }
    asOf = parsedDate;
  }

  let lock;
  try {
    lock = await detectAndParse(cwd, flags.lockfile);
  } catch (err) {
    if (err instanceof NoLockfileError) fail(err.message);
    fail(err instanceof Error ? err.message : String(err));
  }

  if (lock.entries.length === 0) {
    fail(`${lock.path} parsed cleanly but lists no registry packages.`);
  }

  const registryConfig = resolveRegistry(cwd, flags.registry);
  const palette = pickPalette({ noColor: flags['no-color'], stream: process.stdout });
  const interactive = Boolean(process.stdout.isTTY) && !flags.json;

  const names = [...new Set(lock.entries.map((e) => e.name))];
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

  const meta = await client.fetchAll(names);

  const result = buildAudit(lock, meta, {
    minAgeDays: minAge,
    asOf,
    asOfExplicit,
    onlyDirect: flags['only-direct'],
    prodOnly: flags.prod,
    registry: registryConfig.default,
    offline: flags.offline,
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const top = flags.top !== undefined ? parseNumber(flags.top, '--top', 0) : undefined;
    process.stdout.write(
      renderTable(result, { palette, top: top && top > 0 ? top : undefined, all: flags.all }),
    );
    if (result.totals.unknown > 0 && flags.offline) {
      process.stderr.write(
        `${result.totals.unknown} package(s) are not in the cache; run once without --offline.\n`,
      );
    }
  }

  return result.totals.young > 0 ? EXIT_YOUNG : EXIT_OK;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`dep-cooldown: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = EXIT_ERROR;
    },
  );
}
