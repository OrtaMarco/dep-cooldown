import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistryClient, diskCache, DEFAULT_REGISTRY } from '../dist/index.js';

/**
 * The only test that leaves the machine. Everything else runs against
 * `test/fixtures/registry/*.json`, so CI and offline development stay green.
 *
 *   DEP_COOLDOWN_NETWORK=1 npm run test:network
 */
const enabled = process.env.DEP_COOLDOWN_NETWORK === '1';
const config = { default: DEFAULT_REGISTRY, scoped: new Map(), source: 'test' };

describe('live registry (opt-in)', { skip: enabled ? false : 'set DEP_COOLDOWN_NETWORK=1' }, () => {
  test('the real packument carries the publish dates we rely on', async () => {
    const cache = diskCache(await mkdtemp(join(tmpdir(), 'dep-cooldown-net-')));
    const client = createRegistryClient({ config, cache, concurrency: 4 });
    const meta = await client.fetchAll(['ms', 'picocolors']);

    const ms = meta.get('ms');
    assert.equal(ms.error, undefined, `ms failed: ${ms.error}`);
    // ms@2.1.3 shipped in March 2020 and will never move.
    assert.equal(ms.meta.time['2.1.3'].slice(0, 4), '2020');
    assert.equal(ms.meta.versions['2.1.3'].provenance, false);

    const pico = meta.get('picocolors');
    assert.equal(pico.error, undefined);
    assert.ok(Object.keys(pico.meta.time).length >= 5);
  });

  test('a package that does not exist is reported, not thrown', async () => {
    const cache = diskCache(await mkdtemp(join(tmpdir(), 'dep-cooldown-net-')));
    const client = createRegistryClient({ config, cache });
    const meta = await client.fetchAll(['dep-cooldown-this-package-does-not-exist-9f3a']);
    const [outcome] = [...meta.values()];
    assert.equal(outcome.error, 'not found in registry');
  });

  test('the second call is served from the disk cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-net-'));
    const cache = diskCache(dir);
    await createRegistryClient({ config, cache }).fetchAll(['ms']);

    let calls = 0;
    const counting = async (...args) => {
      calls++;
      return globalThis.fetch(...args);
    };
    const second = createRegistryClient({ config, cache, fetchImpl: counting });
    const meta = await second.fetchAll(['ms']);
    assert.equal(calls, 0);
    assert.equal(meta.get('ms').cached, true);
  });

  test('provenance is detected on a package known to publish with it', async () => {
    const cache = diskCache(await mkdtemp(join(tmpdir(), 'dep-cooldown-net-')));
    const client = createRegistryClient({ config, cache });
    const meta = await client.fetchAll(['tsup']);
    const outcome = meta.get('tsup');
    assert.equal(outcome.error, undefined);
    const withProvenance = Object.values(outcome.meta.versions).filter((v) => v.provenance);
    assert.ok(
      withProvenance.length > 0,
      'expected at least one tsup version published with provenance',
    );
  });
});
