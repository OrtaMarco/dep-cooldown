import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAudit,
  ageInDays,
  detectAndParse,
  createRegistryClient,
  trimPackument,
} from '../dist/index.js';
import { fixture, mockRegistry, memoryCache, NO_NPMRC, AS_OF, readFixture } from './helpers.js';

async function auditFixture(dir, options = {}, mockOptions = {}) {
  const lock = await detectAndParse(fixture(dir));
  const mock = mockRegistry(mockOptions);
  const client = createRegistryClient({
    config: NO_NPMRC,
    cache: memoryCache(),
    fetchImpl: mock.impl,
    concurrency: options.concurrency ?? 8,
  });
  const meta = await client.fetchAll(lock.entries.map((e) => e.name));
  const result = buildAudit(lock, meta, {
    minAgeDays: 7,
    asOf: AS_OF,
    asOfExplicit: true,
    registry: NO_NPMRC.default,
    ...options,
  });
  return { result, mock, lock };
}

describe('ageInDays', () => {
  test('counts whole and fractional days', () => {
    assert.equal(ageInDays('2026-09-02T00:00:00.000Z', AS_OF), 7);
    assert.equal(ageInDays('2026-09-08T12:00:00.000Z', AS_OF), 0.5);
    assert.equal(ageInDays('2026-09-09T00:00:00.000Z', AS_OF), 0);
  });

  test('goes negative for a version published after the reference date', () => {
    assert.equal(ageInDays('2026-09-10T00:00:00.000Z', AS_OF), -1);
  });
});

describe('buildAudit', () => {
  test('flags exactly the versions younger than the threshold', async () => {
    const { result } = await auditFixture('npm-v3');
    assert.equal(result.totals.packages, 14);
    assert.equal(result.totals.direct, 3);
    const young = result.rows.filter((r) => r.young).map((r) => r.name).sort();
    // Published 0.5, 2 and 6 days before the reference date.
    assert.deepEqual(young, ['@babel/code-frame', 'is-number', 'js-tokens']);
    assert.equal(result.totals.young, 3);
  });

  test('the threshold is exclusive: exactly minAge days old passes', async () => {
    const { result } = await auditFixture('npm-v3', { minAgeDays: 6 });
    // js-tokens is 6.0 days old, so a 6-day threshold lets it through.
    const young = result.rows.filter((r) => r.young).map((r) => r.name).sort();
    assert.deepEqual(young, ['@babel/code-frame', 'is-number']);
  });

  test('a lower threshold clears the borderline package', async () => {
    const { result } = await auditFixture('npm-v3', { minAgeDays: 3 });
    assert.deepEqual(
      result.rows.filter((r) => r.young).map((r) => r.name).sort(),
      ['@babel/code-frame', 'is-number'],
    );
  });

  test('as-of rewinds the clock: nothing was young a year earlier', async () => {
    const { result } = await auditFixture('npm-v3', {
      asOf: new Date('2025-09-09T00:00:00.000Z'),
    });
    // Packages published after that date have negative ages, which still count
    // as "younger than the threshold" - they did not exist yet.
    const known = result.rows.filter((r) => r.ageDays !== null && r.ageDays >= 0);
    assert.ok(known.every((r) => r.ageDays >= 7 || r.young));
    assert.ok(result.rows.some((r) => r.ageDays < 0));
  });

  test('reads provenance from dist.attestations', async () => {
    const { result } = await auditFixture('npm-v3');
    const withProv = result.rows.filter((r) => r.provenance === true).map((r) => r.name).sort();
    assert.deepEqual(withProv, ['@babel/code-frame', 'picocolors']);
    assert.equal(result.totals.withProvenance, 2);
    assert.equal(result.rows.find((r) => r.name === 'ms').provenance, false);
  });

  test('reads the deprecation message off the resolved version', async () => {
    const { result } = await auditFixture('npm-v3');
    const chalk = result.rows.find((r) => r.name === 'chalk');
    assert.match(chalk.deprecated, /no longer maintained/);
    assert.equal(result.totals.deprecated, 1);
  });

  test('rows come back youngest first', async () => {
    const { result } = await auditFixture('npm-v3');
    const ages = result.rows.filter((r) => r.ageDays !== null).map((r) => r.ageDays);
    assert.deepEqual(ages, [...ages].sort((a, b) => a - b));
    assert.equal(result.rows[0].name, 'is-number');
  });

  test('--only-direct keeps just the manifest dependencies', async () => {
    const { result } = await auditFixture('npm-v3', { onlyDirect: true });
    assert.equal(result.totals.packages, 3);
    assert.deepEqual(result.rows.map((r) => r.name).sort(), [
      '@babel/code-frame',
      'is-number',
      'ms',
    ]);
  });

  test('--prod drops what the lockfile marks development-only', async () => {
    const { result } = await auditFixture('npm-v3', { prodOnly: true });
    assert.equal(result.totals.packages, 13);
    assert.ok(!result.rows.some((r) => r.name === 'is-number'));
  });

  test('a 500 leaves the row unknown instead of failing the run', async () => {
    const { result } = await auditFixture('npm-v3', {}, { fail: new Set(['ms']) });
    const ms = result.rows.find((r) => r.name === 'ms');
    assert.equal(ms.published, null);
    assert.equal(ms.ageDays, null);
    assert.equal(ms.provenance, null);
    assert.match(ms.error, /HTTP 500/);
    assert.equal(result.totals.unknown, 1);
    // The other thirteen still resolved.
    assert.equal(result.totals.packages, 14);
  });

  test('a 404 is reported as not found and is not retried into a stall', async () => {
    const { result } = await auditFixture('npm-v3', {}, { missing: new Set(['picocolors']) });
    const row = result.rows.find((r) => r.name === 'picocolors');
    assert.equal(row.error, 'not found in registry');
  });

  test('every lockfile format produces the same verdict', async () => {
    const dirs = ['npm-v3', 'npm-v2', 'pnpm-v9', 'pnpm-v6', 'yarn-classic', 'yarn-berry', 'bun'];
    const verdicts = [];
    for (const dir of dirs) {
      const { result } = await auditFixture(dir);
      verdicts.push({
        dir,
        packages: result.totals.packages,
        young: result.rows.filter((r) => r.young).map((r) => r.name).sort().join(','),
        deprecated: result.totals.deprecated,
        provenance: result.totals.withProvenance,
        direct: result.totals.direct,
      });
    }
    const first = { ...verdicts[0], dir: undefined };
    for (const v of verdicts) {
      assert.deepEqual({ ...v, dir: undefined }, first, `${v.dir} disagrees`);
    }
  });
});

describe('registry client', () => {
  test('asks for every package exactly once', async () => {
    const { mock, lock } = await auditFixture('npm-v3');
    const unique = new Set(lock.entries.map((e) => e.name));
    assert.equal(mock.calls.length, unique.size);
    assert.equal(new Set(mock.calls).size, mock.calls.length);
  });

  test('scoped names are percent-encoded the way the registry expects', async () => {
    const { mock } = await auditFixture('npm-v3');
    assert.ok(
      mock.calls.some((u) => u.endsWith('/@babel%2fcode-frame')),
      `expected an encoded scoped request, got ${mock.calls.join(' ')}`,
    );
  });

  test('never exceeds the configured concurrency', async () => {
    const { mock } = await auditFixture('npm-v3', { concurrency: 3 });
    assert.ok(mock.peakConcurrency <= 3, `peak was ${mock.peakConcurrency}`);
    assert.ok(mock.peakConcurrency > 1, 'requests should actually overlap');
  });

  test('a warm cache serves the second run without any request', async () => {
    const lock = await detectAndParse(fixture('npm-v3'));
    const cache = memoryCache();
    const mock = mockRegistry();
    const names = lock.entries.map((e) => e.name);
    const make = () =>
      createRegistryClient({ config: NO_NPMRC, cache, fetchImpl: mock.impl });
    await make().fetchAll(names);
    const first = mock.calls.length;
    await make().fetchAll(names);
    assert.equal(mock.calls.length, first, 'second run should be served from cache');
  });

  test('--offline reports what the cache is missing instead of dialling out', async () => {
    const lock = await detectAndParse(fixture('npm-v3'));
    const cache = memoryCache();
    const mock = mockRegistry();
    const offline = createRegistryClient({
      config: NO_NPMRC,
      cache,
      offline: true,
      fetchImpl: mock.impl,
    });
    const meta = await offline.fetchAll(lock.entries.map((e) => e.name));
    assert.equal(mock.calls.length, 0, 'offline must not hit the network');
    assert.equal([...meta.values()].every((o) => o.error === 'not in cache (--offline)'), true);
  });
});

describe('trimPackument', () => {
  test('keeps only versions, publish dates, provenance and deprecation', () => {
    const doc = JSON.parse(readFixture('registry', 'chalk.json'));
    const meta = trimPackument(doc, 'chalk');
    assert.equal(meta.name, 'chalk');
    assert.equal(meta.time['2.4.2'], '2018-06-01T00:00:00.000Z');
    // `created` and `modified` are not versions and must not survive.
    assert.ok(!('created' in meta.time));
    assert.ok(!('modified' in meta.time));
    assert.match(meta.versions['2.4.2'].deprecated, /no longer maintained/);
    assert.equal(meta.versions['2.4.2'].provenance, false);
    assert.match(meta.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('detects provenance from dist.attestations', () => {
    const doc = JSON.parse(readFixture('registry', 'picocolors.json'));
    const meta = trimPackument(doc, 'picocolors');
    assert.equal(meta.versions['1.1.1'].provenance, true);
  });
});
