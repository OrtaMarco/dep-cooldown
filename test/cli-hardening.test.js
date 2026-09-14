// Regression tests for the security review of the CLI, the audit and the
// report: how the bin is invoked, what each exit code means, what counts as
// "checked", flag validation and terminal-escape injection.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, symlink, cp, stat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAudit, renderTable, noColor } from '../dist/index.js';

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
/** Whatever `package.json` says the bin is: that is what npx and .bin run. */
const BIN_REL = typeof PKG.bin === 'string' ? PKG.bin : PKG.bin['dep-cooldown'];
const BIN = join(ROOT, BIN_REL);
const DAY = 24 * 60 * 60 * 1000;
/** Every C0/C1 control character except the newline the report is made of. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/**
 * Runs a file and returns `{code, stdout, stderr}`. `viaNode: false` executes
 * the file itself, which needs the shebang and the executable bit.
 */
async function exec(file, args, { env = {}, viaNode = true } = {}) {
  const options = { env: { ...process.env, NO_COLOR: '1', ...env }, maxBuffer: 20 * 1024 * 1024 };
  try {
    const { stdout, stderr } = viaNode
      ? await execFileP(process.execPath, [file, ...args], options)
      : await execFileP(file, args, options);
    return { code: 0, stdout, stderr };
  } catch (err) {
    // A spawn failure (EACCES, ENOENT) is not an exit code: let it fail loudly.
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// --- a fake registry -------------------------------------------------------

let server;
let registry;
let cacheDir;
const routes = new Map();

function packument(name, time) {
  const versions = {};
  for (const v of Object.keys(time)) versions[v] = { name, version: v, dist: {} };
  return { name, time, versions };
}

before(async () => {
  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  routes.set('old', [200, packument('old', { '1.0.0': ago(900 * DAY) })]);
  routes.set('old2', [200, packument('old2', { '1.0.0': ago(400 * DAY) })]);
  routes.set('young', [200, packument('young', { '1.0.0': ago(3600 * 1000) })]);
  routes.set('almostseven', [200, packument('almostseven', { '1.0.0': ago(6.96 * DAY) })]);
  routes.set('nantime', [200, packument('nantime', { '1.0.0': 'yesterday-ish' })]);
  routes.set('notime', [200, { name: 'notime', versions: { '1.0.0': { dist: {} } } }]);
  routes.set('private', [401, { error: 'auth required' }]);

  server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1).split('?')[0]);
    const route = routes.get(name) ?? [404, { error: 'Not found' }];
    res.writeHead(route[0], { 'content-type': 'application/json' });
    res.end(JSON.stringify(route[1]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  registry = `http://127.0.0.1:${server.address().port}`;
  cacheDir = await mkdtemp(join(tmpdir(), 'dep-cooldown-hard-cache-'));
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

/**
 * Writes an npm v3 lockfile. `deps` are names (version 1.0.0) or
 * `{name, version, direct, dev}`. `resolved` points at the fake registry, so
 * the tarball and the packument come from the same place.
 */
async function project(deps) {
  const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-hard-'));
  const packages = { '': { name: 'p', version: '1.0.0', dependencies: {} } };
  for (const raw of deps) {
    const d = typeof raw === 'string' ? { name: raw } : raw;
    const version = d.version ?? '1.0.0';
    if (d.direct !== false) packages[''].dependencies[d.name] = version;
    packages[`node_modules/${d.name.replace(/[^\w@/-]/g, '_')}`] = {
      name: d.name,
      version,
      resolved: `${registry}/${d.name}/-/${d.name}-${version}.tgz`,
      ...(d.dev ? { dev: true } : {}),
    };
  }
  await writeFile(
    join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'p', lockfileVersion: 3, packages }, null, 2),
  );
  return dir;
}

function audit(dir, args = []) {
  return exec(BIN, ['--cwd', dir, '--registry', registry, '--no-cache', ...args], {
    env: { DEP_COOLDOWN_CACHE_DIR: cacheDir },
  });
}

// --- pure helpers for buildAudit / renderTable -----------------------------

const AS_OF = new Date('2026-09-09T00:00:00.000Z');

function lockOf(entries, skipped) {
  return {
    manager: 'npm',
    path: '/x/package-lock.json',
    format: 'package-lock.json v3',
    mtime: AS_OF.toISOString(),
    entries: entries.map((e) => ({ direct: true, dev: false, version: '1.0.0', ...e })),
    ...(skipped ? { skipped } : {}),
  };
}

function metaOf(docs) {
  const map = new Map();
  for (const [name, { time = {}, versions }] of Object.entries(docs)) {
    const v = versions ?? Object.fromEntries(Object.keys(time).map((k) => [k, { provenance: false }]));
    map.set(name, { meta: { name, time, versions: v, fetchedAt: AS_OF.toISOString() }, cached: false });
  }
  return map;
}

function auditOf(entries, docs, options = {}, skipped) {
  return buildAudit(lockOf(entries, skipped), metaOf(docs), {
    minAgeDays: 7,
    asOf: AS_OF,
    asOfExplicit: true,
    registry: 'https://registry.npmjs.org',
    ...options,
  });
}

const before_ = (ms) => new Date(AS_OF.getTime() - ms).toISOString();

// ---------------------------------------------------------------------------

describe('bin entry point', () => {
  test('package.json bin is a file with a shebang and the executable bit', async () => {
    const head = (await readFile(BIN, 'utf8')).split('\n', 1)[0];
    assert.equal(head, '#!/usr/bin/env node');
    assert.ok(((await stat(BIN)).mode & 0o111) !== 0, `${BIN_REL} is not executable`);
  });

  test('runs through a symlink, the way node_modules/.bin and npx invoke it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-bin-'));
    await mkdir(join(dir, '.bin'));
    const link = join(dir, '.bin', 'dep-cooldown');
    await symlink(BIN, link);

    const direct = await exec(link, ['--version'], { viaNode: false });
    assert.equal(direct.code, 0);
    assert.match(direct.stdout, /^\d+\.\d+\.\d+\n$/, 'exactly one version line: main ran once');

    const viaNode = await exec(link, ['--version']);
    assert.match(viaNode.stdout, /^\d+\.\d+\.\d+\n$/);

    // Not a silent no-op: a bad flag through the symlink is a real exit 2.
    const bad = await exec(link, ['--nope'], { viaNode: false });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Run --help for usage/);
  });

  test('runs from an install path containing # and %41', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dep-cooldown-bin-'));
    const pkgDir = join(base, 'we#ird%41dir');
    await mkdir(pkgDir);
    await cp(join(ROOT, 'dist'), join(pkgDir, 'dist'), { recursive: true });
    await cp(join(ROOT, 'package.json'), join(pkgDir, 'package.json'));
    await symlink(join(ROOT, 'node_modules'), join(pkgDir, 'node_modules'));

    const res = await exec(join(pkgDir, BIN_REL), ['--version']);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /^\d+\.\d+\.\d+\n$/);
  });

  test('node dist/cli.js still runs the CLI (the CI dogfooding step uses it)', async () => {
    const res = await exec(join(ROOT, 'dist', 'cli.js'), ['--version']);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /^\d+\.\d+\.\d+\n$/);
  });
});

describe('exit codes', () => {
  test('0 when every version is old enough', async () => {
    const { code, stdout } = await audit(await project(['old', 'old2']));
    assert.equal(code, 0);
    assert.match(stdout, /OK/);
  });

  test('1 when a version is younger than --min-age', async () => {
    const { code, stdout } = await audit(await project(['old', 'young']));
    assert.equal(code, 1);
    assert.match(stdout, /YOUNG/);
  });

  test('3 when nothing is young but a package was not found, with one stderr line saying why', async () => {
    const { code, stdout, stderr } = await audit(await project(['old', 'missing']));
    assert.equal(code, 3);
    assert.doesNotMatch(stdout, /\bOK\b/);
    const lines = stderr.trimEnd().split('\n');
    assert.equal(lines.length, 1, `expected one stderr line, got: ${stderr}`);
    assert.match(lines[0], /1 package.*could not be checked/);
    assert.match(lines[0], /--allow-unknown/);
  });

  test('3 on a 401, on a packument without time and on an unreadable date', async () => {
    for (const name of ['private', 'notime', 'nantime']) {
      const { code, stdout } = await audit(await project(['old', name]), ['--json']);
      assert.equal(code, 3, name);
      const row = JSON.parse(stdout).rows.find((r) => r.name === name);
      assert.equal(row.ageDays, null, name);
      assert.equal(row.young, false, name);
      assert.ok(row.error, `${name} should carry an error`);
    }
  });

  test('3 with --json too, and stdout stays valid JSON', async () => {
    const { code, stdout, stderr } = await audit(await project(['old', 'missing']), ['--json']);
    assert.equal(code, 3);
    assert.equal(JSON.parse(stdout).totals.unknown, 1);
    assert.equal(stderr.trimEnd().split('\n').length, 1);
  });

  test('--allow-unknown turns 3 into 0', async () => {
    const { code, stdout } = await audit(await project(['old', 'missing']), ['--allow-unknown']);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /every resolved version/);
  });

  test('young and unknown together exit 1, with or without --allow-unknown', async () => {
    const dir = await project(['young', 'missing']);
    assert.equal((await audit(dir)).code, 1);
    assert.equal((await audit(dir, ['--allow-unknown'])).code, 1);
  });

  test('--offline with an empty cache is 3, not a pass', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dep-cooldown-hard-cache-'));
    const { code } = await exec(BIN, ['--cwd', await project(['old']), '--offline', '--json'], {
      env: { DEP_COOLDOWN_CACHE_DIR: empty },
    });
    assert.equal(code, 3);
  });

  test('--help documents every exit code and --allow-unknown', async () => {
    const { code, stdout } = await exec(BIN, ['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--allow-unknown/);
    for (const n of ['0', '1', '2', '3']) assert.match(stdout, new RegExp(`^  ${n}  `, 'm'));
  });

  test('--concurrency must be a whole number >= 1', async () => {
    const dir = await project(['old']);
    for (const bad of ['0.5', '0', '-1', '1.5', '', 'abc', '1e1']) {
      const { code, stderr } = await audit(dir, [`--concurrency=${bad}`]);
      assert.equal(code, 2, `--concurrency ${JSON.stringify(bad)}`);
      assert.match(stderr, /--concurrency expects a whole number/);
    }
    assert.equal((await audit(dir, ['--concurrency', '1'])).code, 0);
  });

  test('--top must be a whole number >= 1, and never hides a young row behind OK', async () => {
    const dir = await project(['old', 'young']);
    const { code, stdout } = await audit(dir, ['--top', '0.5']);
    assert.equal(code, 2);
    assert.doesNotMatch(stdout, /OK/);
    assert.equal((await audit(dir, ['--top', '1'])).code, 1);
  });
});

describe('what was actually checked', () => {
  test('--only-direct that leaves nothing to audit exits 2, not OK', async () => {
    const dir = await project([{ name: 'old', direct: false }]);
    const { code, stdout, stderr } = await audit(dir, ['--only-direct']);
    assert.equal(code, 2);
    assert.doesNotMatch(stdout, /OK/);
    assert.match(stderr, /--only-direct/);
    assert.match(stderr, /nothing to audit/);
  });

  test('--prod that leaves nothing to audit exits 2', async () => {
    const dir = await project([{ name: 'old', dev: true }]);
    const { code, stderr } = await audit(dir, ['--prod']);
    assert.equal(code, 2);
    assert.match(stderr, /--prod/);
  });

  test('a lockfile with no dependencies at all is OK', async () => {
    const { code, stdout } = await audit(await project([]));
    assert.equal(code, 0);
    assert.match(stdout, /OK/);
    assert.doesNotMatch(stdout, /every resolved version/);
  });
});

describe('flag validation', () => {
  test('--min-age rejects an empty string and anything that is not a plain decimal', async () => {
    for (const bad of ['', ' 7', '7 ', '1e1', '0x7', '7.', '.5', '-1', 'Infinity', '7d']) {
      // `--flag=value`, so parseArgs hands over "" and "-1" instead of refusing them itself.
      const { code, stderr } = await exec(BIN, [`--min-age=${bad}`, '--config', 'npm']);
      assert.equal(code, 2, `--min-age ${JSON.stringify(bad)}`);
      assert.match(stderr, /--min-age expects a non-negative number/);
    }
    for (const good of ['0', '7', '0.5', '14.25']) {
      const { code, stdout } = await exec(BIN, ['--min-age', good, '--config', 'npm']);
      assert.equal(code, 0, `--min-age ${good}`);
      // npm takes whole days, so renderConfig rounds 0.5 up; only acceptance matters here.
      assert.match(stdout, /^min-release-age=\d+$/m);
    }
  });

  test('--as-of requires ISO 8601: a date, or a date-time with a zone', async () => {
    const dir = await project(['old']);
    const rejected = [
      '7',
      'Sep 1',
      '',
      '2026-9-1',
      '2026-02-31',
      '2026-13-01',
      '2026-09-04T24:00:00Z',
      '2026-09-04T16:12:01',
      '2026-09-04 16:12:01Z',
      '2026-09-04T16:12:01+0000',
    ];
    for (const bad of rejected) {
      const { code, stderr } = await audit(dir, [`--as-of=${bad}`]);
      assert.equal(code, 2, `--as-of ${JSON.stringify(bad)}`);
      assert.match(stderr, /--as-of expects an ISO date/);
    }
    const accepted = {
      '2026-09-04': '2026-09-04T00:00:00.000Z',
      '2026-09-04T16:12:01+00:00': '2026-09-04T16:12:01.000Z',
      '2026-09-04T16:12:01Z': '2026-09-04T16:12:01.000Z',
      '2026-09-04T16:12:01.123Z': '2026-09-04T16:12:01.123Z',
      '2026-09-10T10:47:13-06:00': '2026-09-10T16:47:13.000Z',
    };
    for (const [good, iso] of Object.entries(accepted)) {
      const { code, stdout } = await audit(dir, ['--as-of', good, '--json']);
      assert.equal(code, 0, `--as-of ${good}`);
      assert.equal(JSON.parse(stdout).asOf, iso);
    }
  });

  test('a version 6.96 days old fails --min-age 7 and does not display as 7.0', async () => {
    const { code, stdout } = await audit(await project(['almostseven']), ['--min-age', '7']);
    assert.equal(code, 1);
    const line = stdout.split('\n').find((l) => l.startsWith('almostseven'));
    assert.match(line, /YOUNG/);
    assert.doesNotMatch(line, /\b7\.0\b/);
  });
});

describe('audit verdicts', () => {
  test('an unreadable or non-ISO publish date is unknown, never approved', () => {
    const result = auditOf(
      [
        { name: 'a', version: '1.0.0' },
        { name: 'a', version: '2.0.0' },
        { name: 'a', version: '3.0.0' },
      ],
      { a: { time: { '1.0.0': 'yesterday-ish', '2.0.0': '1', '3.0.0': 12345 } } },
    );
    for (const row of result.rows) {
      assert.equal(row.ageDays, null, row.version);
      assert.equal(row.published, null, row.version);
      assert.equal(row.young, false, row.version);
      assert.match(row.error, /publish date/, row.version);
    }
    assert.equal(result.totals.unknown, 3);
  });

  test('versions named after Object.prototype members are not read off the prototype', () => {
    const result = auditOf(
      [
        { name: 'p', version: '__proto__' },
        { name: 'p', version: 'constructor' },
        { name: 'p', version: 'toString' },
      ],
      { p: { time: {}, versions: {} } },
    );
    for (const row of result.rows) {
      assert.equal(row.ageDays, null, row.version);
      assert.equal(row.published, null, row.version);
      assert.equal(row.deprecated, null, row.version);
      assert.equal(row.error, 'version not listed in registry', row.version);
    }
    assert.equal(result.totals.unknown, 3);

    // An own `__proto__` key, as JSON.parse produces from a cached record, is real data.
    const own = JSON.parse(`{"__proto__": "${before_(30 * DAY)}"}`);
    const ok = auditOf([{ name: 'q', version: '__proto__' }], { q: { time: own } });
    assert.equal(ok.rows[0].ageDays, 30);
    assert.equal(ok.totals.unknown, 0);
  });

  test('an unverifiable entry is unknown with its reason, even when the registry has a date', () => {
    const result = auditOf(
      [{ name: 'x', version: '1.0.0', unverifiable: 'resolved from https://evil.test, not the registry' }],
      { x: { time: { '1.0.0': before_(900 * DAY) } } },
    );
    const row = result.rows[0];
    assert.equal(row.ageDays, null);
    assert.equal(row.published, null);
    assert.equal(row.provenance, null);
    assert.equal(row.young, false);
    assert.equal(row.error, 'resolved from https://evil.test, not the registry');
    assert.equal(result.totals.unknown, 1);
  });

  test('the threshold compares exact time, and the shown age never contradicts the verdict', () => {
    const cases = [
      [7, 7 * DAY - 1],
      [7, 6.96 * DAY],
      [7, 7 * DAY],
      [7, 7 * DAY + 1],
      [7.25, 7.249 * DAY],
      [7.25, 7.26 * DAY],
      [0.5, 0.4999 * DAY],
      [150.5, 150.7 * DAY],
      [150.5, 150.45 * DAY],
    ];
    for (const [min, delta] of cases) {
      const result = auditOf([{ name: 'a' }], { a: { time: { '1.0.0': before_(delta) } } }, { minAgeDays: min });
      const row = result.rows[0];
      const label = `min ${min}, age ${delta / DAY}d`;
      assert.equal(row.young, delta < min * DAY, label);
      assert.equal(row.ageDays < min, row.young, `${label}: ageDays ${row.ageDays}`);
    }
  });

  test('a version dated after the reference date is young and says so', () => {
    const result = auditOf([{ name: 'a' }], {
      a: { time: { '1.0.0': new Date(AS_OF.getTime() + 2 * DAY).toISOString() } },
    }, { minAgeDays: 0 });
    const row = result.rows[0];
    assert.equal(row.young, true);
    assert.ok(row.ageDays < 0);
    const out = renderTable(result, { palette: noColor });
    assert.match(out, /FUTURE/);
    assert.match(out, /after the reference date/);
  });
});

describe('report', () => {
  const OLD = { time: { '1.0.0': before_(900 * DAY) } };

  test('a clean audit says OK and exactly what it checked', () => {
    const out = renderTable(auditOf([{ name: 'a' }, { name: 'b' }], { a: OLD, b: OLD }), { palette: noColor });
    assert.match(out, /^OK - all 2 audited package versions are at least 7 day\(s\) old as of 2026-09-09/m);
  });

  test('OK never appears when something was skipped or unknown', () => {
    const skipped = [
      { name: 'g', spec: 'git+ssh://git@github.com/x/g.git', reason: 'git' },
      { name: 'f', spec: 'file:../f', reason: 'file' },
    ];
    const withSkipped = auditOf([{ name: 'a' }], { a: OLD }, {}, skipped);
    assert.doesNotMatch(renderTable(withSkipped, { palette: noColor }), /\bOK\b/);
    assert.doesNotMatch(renderTable(withSkipped, { palette: noColor, all: true }), /\bOK\b/);

    const withUnknown = auditOf([{ name: 'a' }, { name: 'z' }], { a: OLD });
    assert.doesNotMatch(renderTable(withUnknown, { palette: noColor }), /\bOK\b/);
  });

  test('skipped entries get a summary line, and --all lists them', () => {
    const skipped = [
      { name: 'g', spec: 'git+ssh://git@github.com/x/g.git', reason: 'git' },
      { name: 'h', spec: 'github:x/h', reason: 'git' },
      { name: 'f', spec: 'file:../f', reason: 'file' },
    ];
    const result = auditOf([{ name: 'a' }], { a: OLD }, {}, skipped);
    assert.equal(result.totals.skipped, 3);
    const out = renderTable(result, { palette: noColor });
    assert.match(out, /^3 skipped \(2 git, 1 file:\)/m);
    assert.doesNotMatch(out, /git\+ssh/);

    const all = renderTable(result, { palette: noColor, all: true });
    assert.match(all, /git\+ssh:\/\/git@github\.com\/x\/g\.git/);
    assert.match(all, /file:\.\.\/f/);
  });

  test('control characters in cells, errors and the header are escaped visibly', () => {
    const result = auditOf(
      [
        { name: 'evil\u001b[2J\u001b]8;;https://evil.test\u0007click', version: '1.0.0\r\u009b31m' },
        { name: 'other', version: '1.0.0' },
      ],
      { other: OLD },
      {},
      [{ name: 's\u001b[31m', spec: 'git+\u0007x', reason: 'git' }],
    );
    result.rows.find((r) => r.name === 'other').error = 'HTTP 503 \u001b]0;owned\u0007';
    result.rows.find((r) => r.name === 'other').ageDays = null;
    result.format = 'package-lock.json v\u001b[31m3';
    result.registry = 'https://r.test/\u001b]8;;x\u001b\\';
    for (const all of [false, true]) {
      const out = renderTable(result, { palette: noColor, all });
      assert.doesNotMatch(out, CONTROL, `all=${all}`);
      assert.match(out, /evil\\x1b\[2J/);
    }
  });

  test('bidi overrides and zero-width characters cannot disguise a name', () => {
    const result = auditOf(
      [
        { name: 'lodash\u200b', version: '4.17.21' },
        { name: 'sj-hsadol\u202e', version: '1.0.0' },
      ],
      {},
    );
    const out = renderTable(result, { palette: noColor, all: true });
    assert.doesNotMatch(out, /[\u200b\u202e]/);
    assert.match(out, /lodash\\u200b/);
    assert.match(out, /sj-hsadol\\u202e/);
  });

  test('a hostile lockfile cannot drive the terminal through the CLI', async () => {
    // No registry could serve that name, so the parser lists it as skipped;
    // `old` keeps the audit running and --all prints the skipped list.
    const dir = await project([
      'old',
      { name: 'evil\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007', version: '1.0.0\r\u001b[2K' },
    ]);
    for (const args of [[], ['--all']]) {
      const { stdout, stderr } = await audit(dir, args);
      assert.doesNotMatch(stdout, CONTROL, `args=${args}`);
      assert.doesNotMatch(stderr, CONTROL, `args=${args}`);
    }
    const { stdout } = await audit(dir, ['--all']);
    assert.match(stdout, /evil\\x1b\]8/);
  });

  test('error messages on stderr are escaped too', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dep-cooldown-hard-'));
    const noLock = join(base, 'dir\u001b]0;owned\u0007');
    await mkdir(noLock);
    const missing = await exec(BIN, ['--cwd', noLock]);
    assert.equal(missing.code, 2);
    assert.doesNotMatch(missing.stderr, CONTROL);
    assert.match(missing.stderr, /\\x1b/);

    const broken = await mkdtemp(join(tmpdir(), 'dep-cooldown-hard-'));
    await writeFile(join(broken, 'package-lock.json'), '\u001b[2J\u001b]0;pwned\u0007 not json');
    const bad = await exec(BIN, ['--cwd', broken]);
    assert.equal(bad.code, 2);
    assert.doesNotMatch(bad.stderr, CONTROL);
  });
});

describe('registry URL in the report', () => {
  async function withNpmrc(line) {
    const dir = await project(['old']);
    await writeFile(join(dir, '.npmrc'), `${line}\n`);
    return dir;
  }

  function run(dir, args, env = {}) {
    return exec(BIN, ['--cwd', dir, '--no-cache', ...args], {
      env: { DEP_COOLDOWN_CACHE_DIR: cacheDir, ...env },
    });
  }

  test('credentials in the .npmrc registry never reach the table or --json', async () => {
    const dir = await withNpmrc(`registry=${registry.replace('http://', 'http://marco:hunter2@')}/`);
    for (const args of [[], ['--json']]) {
      const { stdout, stderr } = await run(dir, args);
      assert.doesNotMatch(stdout + stderr, /hunter2/, `args=${args}`);
      assert.match(stdout, /\*\*\*@127\.0\.0\.1/, `args=${args}`);
    }
  });

  test('a ${VAR} expanded from the environment is shown as written, not as its value', async () => {
    const dir = await withNpmrc(`registry=${registry}/\${DEPC_TEST_SECRET}/`);
    for (const args of [[], ['--json']]) {
      const { stdout, stderr } = await run(dir, args, { DEPC_TEST_SECRET: 'ghs_SECRETVALUE123' });
      assert.doesNotMatch(stdout + stderr, /ghs_SECRETVALUE123/, `args=${args}`);
      assert.match(stdout, /\$\{DEPC_TEST_SECRET\}/, `args=${args}`);
    }
  });
});

describe('resolved host and lockfile warnings', () => {
  test('a tarball resolved from another host is unverified, exits 3 and names the host once', async () => {
    const dir = await project(['old', 'old2']);
    const path = join(dir, 'package-lock.json');
    const lock = JSON.parse(await readFile(path, 'utf8'));
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key) entry.resolved = entry.resolved.replace(registry, 'https://mirror.example.test');
    }
    await writeFile(path, JSON.stringify(lock, null, 2));

    const { code, stdout, stderr } = await audit(dir);
    assert.equal(code, 3, stdout + stderr);
    assert.match(stdout, /resolved from mirror\.example\.test/);
    const hints = stderr.split('\n').filter((l) => l.includes('were resolved from mirror.example.test'));
    assert.equal(hints.length, 1, stderr);
    assert.match(hints[0], /^dep-cooldown: 2 package\(s\)/);
    assert.match(hints[0], /--registry https:\/\/mirror\.example\.test\//);

    const { code: allowed } = await audit(dir, ['--allow-unknown']);
    assert.equal(allowed, 0);
  });

  test('the same lockfile audited against its own host is fine', async () => {
    const dir = await project(['old']);
    const { code, stderr } = await audit(dir);
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /were resolved from/);
  });

  test('lockfile warnings reach stderr', async () => {
    const dir = await project(['old']);
    const lock = await readFile(join(dir, 'package-lock.json'), 'utf8');
    await writeFile(join(dir, 'npm-shrinkwrap.json'), lock);
    const { code, stderr } = await audit(dir);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /^dep-cooldown: .*npm-shrinkwrap\.json/m);
  });
});
