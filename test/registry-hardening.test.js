import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  stat,
  lstat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A namespace import, so a missing export fails its own test instead of the whole file.
import * as lib from '../dist/index.js';
import { memoryCache, mockRegistry } from './helpers.js';

/**
 * Hardening of the registry client, the `.npmrc` reader and the disk cache.
 * Every registry here is a local server on 127.0.0.1 with an ephemeral port:
 * nothing in this file leaves the machine.
 */

const HOUR = 60 * 60 * 1000;

function configFor(url) {
  return { default: url, scoped: new Map(), source: 'test' };
}

function packument(name, extra = {}) {
  return {
    name,
    time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z' },
    versions: { '1.0.0': { dist: {} } },
    ...extra,
  };
}

/** Starts an HTTP server and records every request it sees. */
async function serve(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    port: server.address().port,
    requests,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Resolves to `'hung'` when `promise` has not settled after `ms`. */
function within(promise, ms) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve('hung'), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function one(client, name) {
  const outcomes = await client.fetchAll([name]);
  return outcomes.get(name);
}

// ---------------------------------------------------------------------------
// 1. Nothing unusable is cached, and concurrency must be a positive integer.
// ---------------------------------------------------------------------------
describe('hardening 1: cache only usable packuments', () => {
  test('a packument without time is an error and is not cached', async () => {
    const srv = await serve((req, res) => json(res, 200, { name: 'notime', versions: { '1.0.0': {} } }));
    try {
      const cache = memoryCache();
      const client = lib.createRegistryClient({ config: configFor(srv.url), cache });
      const outcome = await one(client, 'notime');
      assert.equal(outcome.meta, undefined, 'a document without dates is not data');
      assert.match(outcome.error ?? '', /time/);
      assert.equal(cache.store.size, 0, 'nothing may be cached');
    } finally {
      await srv.close();
    }
  });

  test('a document with an invalid shape is an error and is not cached', async () => {
    const bodies = {
      array: '[]',
      nulldoc: 'null',
      stringtime: JSON.stringify({ name: 'stringtime', time: 'yesterday', versions: {} }),
      arraytime: JSON.stringify({ name: 'arraytime', time: ['2020-01-01'], versions: {} }),
      badversions: JSON.stringify({ name: 'badversions', time: {}, versions: 'nope' }),
    };
    const srv = await serve((req, res) => json(res, 200, bodies[req.url.slice(1)]));
    try {
      const cache = memoryCache();
      const client = lib.createRegistryClient({ config: configFor(srv.url), cache });
      const outcomes = await client.fetchAll(Object.keys(bodies));
      for (const [name, outcome] of outcomes) {
        assert.equal(outcome.meta, undefined, `${name} must not produce data`);
        assert.ok(outcome.error, `${name} must carry an error`);
      }
      assert.equal(cache.store.size, 0, 'nothing may be cached');
    } finally {
      await srv.close();
    }
  });

  test('a concurrency that is not a positive integer is rejected', () => {
    const config = configFor('http://127.0.0.1:9');
    for (const concurrency of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.5, '8']) {
      assert.throws(
        () => lib.createRegistryClient({ config, cache: memoryCache(), concurrency }),
        RangeError,
        `concurrency ${String(concurrency)} should be rejected`,
      );
    }
    for (const concurrency of [1, 3, 64]) {
      assert.doesNotThrow(() =>
        lib.createRegistryClient({ config, cache: memoryCache(), concurrency }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Prototype-free maps, and the document must name the package asked for.
// ---------------------------------------------------------------------------
describe('hardening 2: prototype and package name', () => {
  test('trimPackument builds null-prototype maps and keeps only string dates', () => {
    const doc = JSON.parse(
      '{"name":"x","time":{"__proto__":"2020-01-01T00:00:00.000Z","constructor":"2020-01-01T00:00:00.000Z",' +
        '"1.0.0":"2026-09-14T00:00:00.000Z","2.0.0":{"not":"a date"},"3.0.0":7},' +
        '"versions":{"__proto__":{"deprecated":"polluted","dist":{"attestations":{}}},"1.0.0":{"dist":{}}}}',
    );
    const meta = lib.trimPackument(doc, 'x');
    assert.equal(Object.getPrototypeOf(meta.time), null);
    assert.equal(Object.getPrototypeOf(meta.versions), null);
    assert.equal(meta.time.toString, undefined, 'no inherited keys may answer a version lookup');
    assert.equal(meta.versions.hasOwnProperty, undefined);
    assert.equal(meta.time['1.0.0'], '2026-09-14T00:00:00.000Z');
    assert.equal('2.0.0' in meta.time, false, 'non-string dates are dropped');
    assert.equal('3.0.0' in meta.time, false, 'non-string dates are dropped');
    assert.equal(({}).deprecated, undefined, 'Object.prototype must stay clean');
    assert.equal(({}).provenance, undefined, 'Object.prototype must stay clean');
  });

  test('a document for another package is an error, not data', async () => {
    const srv = await serve((req, res) => json(res, 200, packument('someone-else')));
    try {
      const cache = memoryCache();
      const client = lib.createRegistryClient({ config: configFor(srv.url), cache });
      const outcome = await one(client, 'young');
      assert.equal(outcome.meta, undefined);
      assert.match(outcome.error ?? '', /different package|does not match/);
      assert.equal(cache.store.size, 0);
      assert.throws(() => lib.trimPackument(packument('someone-else'), 'young'));
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Timeouts and a byte cap on the body.
// ---------------------------------------------------------------------------
describe('hardening 3: timeouts and body size', () => {
  test('a registry that trickles one byte at a time is abandoned at the deadline', async () => {
    const srv = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"name":"slow","pad":"');
      const t = setInterval(() => res.write('x'), 100);
      res.on('close', () => clearInterval(t));
    });
    try {
      const client = lib.createRegistryClient({
        config: configFor(srv.url),
        cache: memoryCache(),
        timeoutMs: 400,
        deadlineMs: 1000,
      });
      const started = Date.now();
      const outcome = await within(one(client, 'slow'), 6000);
      assert.notEqual(outcome, 'hung', 'the client must give up on its own');
      assert.match(outcome.error ?? '', /timed out|gave up/);
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    } finally {
      await srv.close();
    }
  });

  test('a body over the byte cap is an error and the connection is aborted', async () => {
    const TOTAL = 64 * 1024 * 1024;
    let sent = 0;
    let finished = false;
    let closedEarly = false;
    const srv = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"name":"huge","time":{"1.0.0":"2020-01-01T00:00:00.000Z"},"versions":{"1.0.0":{}},"pad":"');
      const chunk = 'x'.repeat(256 * 1024);
      res.on('close', () => {
        if (!finished) closedEarly = true;
      });
      const pump = () => {
        while (sent < TOTAL) {
          if (res.destroyed) return;
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        finished = true;
        res.end('"}');
      };
      pump();
    });
    try {
      const client = lib.createRegistryClient({
        config: configFor(srv.url),
        cache: memoryCache(),
        maxBytes: 1024 * 1024,
      });
      const outcome = await within(one(client, 'huge'), 10000);
      assert.notEqual(outcome, 'hung');
      assert.equal(outcome.meta, undefined, 'an oversized body is not data');
      assert.match(outcome.error ?? '', /larger than/);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(finished, false, 'the server should not get to send the whole body');
      assert.equal(closedEarly, true, 'the connection should be closed by the client');
      assert.equal(srv.requests.length, 1, 'an oversized body is not retried');
    } finally {
      await srv.close();
    }
  });

  test('a content-length over the cap is refused before reading the body', async () => {
    const srv = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(512 * 1024 * 1024) });
      res.write('{"name":"declared"');
      // …and then nothing: only the header can end this quickly.
    });
    try {
      const client = lib.createRegistryClient({
        config: configFor(srv.url),
        cache: memoryCache(),
        maxBytes: 1024 * 1024,
        timeoutMs: 20000,
        deadlineMs: 20000,
      });
      const outcome = await within(one(client, 'declared'), 3000);
      assert.notEqual(outcome, 'hung', 'the declared length alone should end the request');
      assert.match(outcome.error ?? '', /larger than/);
    } finally {
      await srv.close();
    }
  });

  test('a multi-megabyte packument under the default cap still works', async () => {
    const versions = {};
    const time = {};
    for (let i = 0; i < 20000; i++) {
      time[`1.0.${i}`] = '2020-01-01T00:00:00.000Z';
      versions[`1.0.${i}`] = { dist: { tarball: `https://example.test/big/-/big-1.0.${i}.tgz` }, pad: 'y'.repeat(200) };
    }
    const body = JSON.stringify({ name: 'big', time, versions });
    assert.ok(body.length > 5 * 1024 * 1024);
    const srv = await serve((req, res) => json(res, 200, body));
    try {
      const client = lib.createRegistryClient({ config: configFor(srv.url), cache: memoryCache() });
      const outcome = await one(client, 'big');
      assert.equal(outcome.error, undefined);
      assert.equal(Object.keys(outcome.meta.versions).length, 20000);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Error messages never carry bytes chosen by the server.
// ---------------------------------------------------------------------------
describe('hardening 4: no server bytes in error messages', () => {
  // biome-ignore lint: control characters are the point of this test.
  const CONTROL = /[ --]/;

  test('an HTTP error carries the status code, not the reason phrase', async () => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.end(
          'HTTP/1.1 503 \x1b[2J\x1b]0;owned\x07Nope\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}',
        );
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = lib.createRegistryClient({
        config: configFor(`http://127.0.0.1:${server.address().port}`),
        cache: memoryCache(),
      });
      const outcome = await one(client, 'young');
      assert.match(outcome.error ?? '', /\b503\b/);
      assert.doesNotMatch(outcome.error, CONTROL);
      assert.doesNotMatch(outcome.error, /Nope|owned/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('invalid JSON does not echo the body', async () => {
    const ESC = '\x1b';
    const body = `${ESC}[2J${ESC}]8;;https://evil.example/${ESC}\\CLICK${ESC}]0;pwned${ESC}\\ not json`;
    const srv = await serve((req, res) => json(res, 200, body));
    try {
      const client = lib.createRegistryClient({ config: configFor(srv.url), cache: memoryCache() });
      const outcome = await one(client, 'badjson');
      assert.ok(outcome.error);
      assert.doesNotMatch(outcome.error, CONTROL);
      assert.doesNotMatch(outcome.error, /evil|CLICK|pwned/);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. .npmrc: redaction, ReDoS, userconfig/env precedence, redirects.
// ---------------------------------------------------------------------------
function withEnv(vars, fn) {
  const saved = new Map();
  const touched = new Set();
  // Clear every case variant of the keys we set, so `npm test` envs do not leak in.
  for (const key of Object.keys(process.env)) {
    for (const wanted of Object.keys(vars)) {
      if (key.toLowerCase() === wanted.toLowerCase()) touched.add(key);
    }
  }
  for (const key of Object.keys(vars)) touched.add(key);
  for (const key of touched) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

describe('hardening 5: .npmrc', () => {
  test('redactRegistryUrl hides userinfo', () => {
    assert.equal(typeof lib.redactRegistryUrl, 'function', 'redactRegistryUrl must be exported');
    const shown = lib.redactRegistryUrl('http://marco:hunter2@127.0.0.1:4873/npm/');
    assert.doesNotMatch(shown, /hunter2|marco/);
    assert.match(shown, /127\.0\.0\.1:4873\/npm/);
    assert.equal(lib.redactRegistryUrl('https://registry.npmjs.org'), 'https://registry.npmjs.org');
    assert.doesNotMatch(lib.redactRegistryUrl('https://tok@en@host.test/'), /tok|en@/);
  });

  test('redactRegistryUrl hides what came from a ${} expansion', async () => {
    assert.equal(typeof lib.redactRegistryUrl, 'function', 'redactRegistryUrl must be exported');
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-redact-'));
    await writeFile(
      join(dir, '.npmrc'),
      [
        'registry=http://127.0.0.1:4873/leak/${DEP_COOLDOWN_TEST_SECRET}/',
        '@acme:registry=https://${DEP_COOLDOWN_TEST_SECRET}@acme.test/npm/',
      ].join('\n'),
    );
    await withEnv(
      { DEP_COOLDOWN_TEST_SECRET: 's3cr3t-value', npm_config_registry: undefined, npm_config_userconfig: join(dir, 'none') },
      () => {
        const config = lib.resolveRegistry(dir);
        // Requests still go where npm would send them…
        assert.equal(config.default, 'http://127.0.0.1:4873/leak/s3cr3t-value');
        // …but nothing meant for a human shows the expanded value.
        const shown = lib.redactRegistryUrl(config.default);
        assert.doesNotMatch(shown, /s3cr3t/);
        assert.match(shown, /\$\{DEP_COOLDOWN_TEST_SECRET\}/);
        const scoped = lib.redactRegistryUrl(config.scoped.get('@acme'));
        assert.doesNotMatch(scoped, /s3cr3t/);
        assert.match(scoped, /acme\.test\/npm/);
      },
    );
  });

  test('credentials in the registry URL are never sent nor echoed in errors', async () => {
    const srv = await serve((req, res) => json(res, 200, packument('young')));
    try {
      const withCreds = srv.url.replace('http://', 'http://marco:hunter2@');
      const client = lib.createRegistryClient({ config: configFor(withCreds), cache: memoryCache() });
      const outcome = await one(client, 'young');
      assert.doesNotMatch(outcome.error ?? '', /hunter2|marco/);
      for (const r of srv.requests) {
        assert.equal(r.headers.authorization, undefined, 'the tool never sends credentials');
      }

      const deadPort = `http://marco:hunter2@127.0.0.1:${await closedPort()}`;
      const dead = lib.createRegistryClient({ config: configFor(deadPort), cache: memoryCache(), deadlineMs: 3000 });
      const failed = await one(dead, 'young');
      assert.ok(failed.error);
      assert.doesNotMatch(failed.error, /hunter2|marco/);
    } finally {
      await srv.close();
    }
  });

  test('${} expansion in .npmrc runs in linear time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-redos-'));
    await writeFile(
      join(dir, '.npmrc'),
      [`registry=${'${'.repeat(80000)}`, `x=${'\\'.repeat(160000)}`, `y=\${${'a'.repeat(160000)}`].join('\n'),
    );
    await withEnv({ npm_config_registry: undefined, npm_config_userconfig: join(dir, 'none') }, () => {
      const started = process.hrtime.bigint();
      lib.resolveRegistry(dir);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // The quadratic pattern took ~8 s on 160 KB; linear takes a few ms.
      assert.ok(ms < 1500, `resolveRegistry took ${ms.toFixed(0)} ms`);
    });
  });

  test('NPM_CONFIG_USERCONFIG points at the user config (actions/setup-node)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-ucfg-'));
    const rc = join(dir, 'runner-temp.npmrc');
    await writeFile(rc, 'registry=https://from-userconfig.test/\n@acme:registry=https://acme-user.test/\n');
    await mkdir(join(dir, 'project'));
    await withEnv({ NPM_CONFIG_USERCONFIG: rc, npm_config_registry: undefined }, () => {
      const config = lib.resolveRegistry(join(dir, 'project'));
      assert.equal(config.default, 'https://from-userconfig.test');
      assert.equal(lib.registryFor('@acme/x', config), 'https://acme-user.test');
    });
  });

  test('npm_config_* is read case-insensitively and an empty value is ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-envcase-'));
    await writeFile(join(dir, '.npmrc'), 'registry=https://project.test/\n');
    await withEnv(
      { npm_config_registry: '', NPM_CONFIG_REGISTRY: 'https://from-env.test/', npm_config_userconfig: join(dir, 'none') },
      () => {
        const config = lib.resolveRegistry(dir);
        assert.equal(config.default, 'https://from-env.test');
      },
    );
    await withEnv(
      { 'npm_config_@acme:registry': 'https://acme-env.test/', npm_config_userconfig: join(dir, 'none') },
      () => {
        assert.equal(lib.registryFor('@acme/x', lib.resolveRegistry(dir)), 'https://acme-env.test');
      },
    );
  });

  test('a redirect to another origin is refused and never requested', async () => {
    const other = await serve((req, res) => json(res, 200, packument('young')));
    const srv = await serve((req, res) => {
      res.writeHead(302, { location: `${other.url}/young` });
      res.end();
    });
    try {
      const client = lib.createRegistryClient({ config: configFor(srv.url), cache: memoryCache() });
      const outcome = await one(client, 'young');
      assert.equal(outcome.meta, undefined);
      assert.match(outcome.error ?? '', /redirect/);
      assert.doesNotMatch(outcome.error, new RegExp(String(other.port)), 'the Location is server bytes');
      assert.equal(other.requests.length, 0, 'the other origin must never be contacted');
    } finally {
      await srv.close();
      await other.close();
    }
  });

  test('a redirect within the same origin is followed', async () => {
    const srv = await serve((req, res) => {
      if (req.url === '/young') {
        res.writeHead(301, { location: '/mirror/young' });
        return res.end();
      }
      json(res, 200, packument('young'));
    });
    try {
      const client = lib.createRegistryClient({ config: configFor(srv.url), cache: memoryCache() });
      const outcome = await one(client, 'young');
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.meta.name, 'young');
    } finally {
      await srv.close();
    }
  });

  test('http -> https on the same host is followed, https -> http is not', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const u = new URL(url);
      const redirect = (location) => ({
        ok: false,
        status: 301,
        headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) },
        json: async () => ({}),
      });
      if (u.hostname === 'plain.test' && u.protocol === 'http:') return redirect(`https://plain.test${u.pathname}`);
      if (u.hostname === 'secure.test' && u.protocol === 'https:') return redirect(`http://secure.test${u.pathname}`);
      return { ok: true, status: 200, json: async () => packument('ms') };
    };
    const up = lib.createRegistryClient({ config: configFor('http://plain.test'), cache: memoryCache(), fetchImpl });
    const upgraded = await one(up, 'ms');
    assert.equal(upgraded.error, undefined, `upgrade should be followed: ${upgraded.error}`);
    assert.deepEqual(calls, ['http://plain.test/ms', 'https://plain.test/ms']);

    const down = lib.createRegistryClient({ config: configFor('https://secure.test'), cache: memoryCache(), fetchImpl });
    const downgraded = await one(down, 'ms');
    assert.match(downgraded.error ?? '', /redirect/);
  });
});

async function closedPort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// 6. Disk cache.
// ---------------------------------------------------------------------------
function cacheFileName(registry, name) {
  const hash = createHash('sha256').update(`${registry}|${name}`).digest('hex').slice(0, 16);
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  return `${safe}-${hash}.json`;
}

const REG = 'https://registry.npmjs.org';

function metaFor(name, extra = {}) {
  return {
    name,
    time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
    versions: { '1.0.0': { provenance: false } },
    fetchedAt: new Date().toISOString(),
    ...extra,
  };
}

describe('hardening 6: disk cache', () => {
  test('an entry fetched "in the future" is expired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const cache = lib.diskCache(dir);
    await cache.set(REG, 'ms', metaFor('ms', { fetchedAt: '2999-01-01T00:00:00.000Z' }));
    assert.equal(await cache.get(REG, 'ms', HOUR), null);
  });

  test('an entry with an unreadable fetchedAt is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const cache = lib.diskCache(dir);
    await cache.set(REG, 'ms', metaFor('ms', { fetchedAt: 'last tuesday' }));
    assert.equal(await cache.get(REG, 'ms', HOUR), null);
    assert.equal(await cache.get(REG, 'ms', Number.POSITIVE_INFINITY), null);
  });

  test('an entry with the wrong shape is absent instead of crashing the audit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const bad = {
      notime: { name: 'notime', versions: {}, fetchedAt: new Date().toISOString() },
      badversion: metaFor('badversion', { versions: { '1.0.0': 'yes' } }),
      nulldoc: null,
      othername: metaFor('someone-else'),
    };
    for (const [name, doc] of Object.entries(bad)) {
      await writeFile(join(dir, cacheFileName(REG, name)), JSON.stringify(doc));
    }
    const cache = lib.diskCache(dir);
    for (const name of Object.keys(bad)) {
      assert.equal(await cache.get(REG, name, HOUR), null, `${name} should read as absent`);
    }
    // A good entry still reads back, with prototype-free maps.
    await cache.set(REG, 'ms', metaFor('ms'));
    const good = await cache.get(REG, 'ms', HOUR);
    assert.equal(good.time['1.0.0'], '2020-01-01T00:00:00.000Z');
    assert.equal(Object.getPrototypeOf(good.time), null);
  });

  test('the temporary file does not follow a planted symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'untouched');
    const target = join(dir, cacheFileName(REG, 'ms'));
    await symlink(victim, `${target}.${process.pid}.tmp`);
    await lib.diskCache(dir).set(REG, 'ms', metaFor('ms'));
    assert.equal(await readFile(victim, 'utf8'), 'untouched');
    const written = await lstat(target);
    assert.ok(written.isFile(), 'the cache entry is a regular file');
    assert.equal(JSON.parse(await readFile(target, 'utf8')).name, 'ms');
  });

  test('the cache directory is created private (0700)', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const dir = join(parent, 'nested', 'dep-cooldown');
    await lib.diskCache(dir).set(REG, 'ms', metaFor('ms'));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  });

  test('clearCache removes only its own files and never follows symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const outside = await mkdtemp(join(tmpdir(), 'dep-cooldown-outside-'));
    const precious = join(outside, `precious-${'0'.repeat(16)}.json`);
    await writeFile(precious, 'keep me');

    const cache = lib.diskCache(dir);
    await cache.set(REG, 'ms', metaFor('ms'));
    await cache.set(REG, '@babel/core', metaFor('@babel/core'));
    await writeFile(join(dir, 'notes.txt'), 'not ours');
    await mkdir(join(dir, 'subdir'));
    await writeFile(join(dir, 'subdir', `inner-${'1'.repeat(16)}.json`), '{}');
    await symlink(precious, join(dir, `link-${'2'.repeat(16)}.json`));
    await symlink(outside, join(dir, `dirlink-${'3'.repeat(16)}.json`));

    await lib.clearCache(dir);

    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [`dirlink-${'3'.repeat(16)}.json`, `link-${'2'.repeat(16)}.json`, 'notes.txt', 'subdir']);
    assert.equal(await readFile(precious, 'utf8'), 'keep me');
    assert.equal(await readFile(join(dir, 'subdir', `inner-${'1'.repeat(16)}.json`), 'utf8'), '{}');
  });

  test('clearCache removes the directory once only its own files were there', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const dir = join(parent, 'dep-cooldown');
    const cache = lib.diskCache(dir);
    await cache.set(REG, 'ms', metaFor('ms'));
    await lib.clearCache(dir);
    assert.deepEqual(await readdir(parent), []);
    // A missing directory is not an error.
    await lib.clearCache(dir);
  });
});

// ---------------------------------------------------------------------------
// 7. Package names are validated before any request.
// ---------------------------------------------------------------------------
describe('hardening 7: package names', () => {
  test('invalid names are an error of that package and make no request', async () => {
    const mock = mockRegistry();
    const client = lib.createRegistryClient({
      config: configFor('https://registry.npmjs.org/some/prefix'),
      cache: memoryCache(),
      fetchImpl: mock.impl,
    });
    const invalid = [
      '..',
      '.',
      '../../etc/passwd',
      'young?x=1#',
      'young#frag',
      '@scope/..',
      '@../x',
      '@scope/',
      '@/x',
      'a/b',
      '@a/b/c',
      ' leading',
      'trailing ',
      '.hidden',
      '_under',
      'node_modules',
      'favicon.ico',
      'a'.repeat(215),
      'with space',
      'ünïcode',
      '',
      'percent%2e%2e',
    ];
    const outcomes = await client.fetchAll(invalid);
    assert.equal(mock.calls.length, 0, `no request expected, got ${mock.calls.join(' ')}`);
    for (const name of invalid) {
      assert.match(outcomes.get(name).error ?? '', /invalid package name/, `${JSON.stringify(name)}`);
    }
  });

  test('valid names, including legacy capitals, are requested with each part encoded', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const client = lib.createRegistryClient({
      config: configFor('https://registry.test/npm'),
      cache: memoryCache(),
      fetchImpl,
    });
    await client.fetchAll(['ms', '@babel/core', 'JSONStream', 'a'.repeat(214), 'lodash.get']);
    assert.deepEqual(calls, [
      'https://registry.test/npm/ms',
      'https://registry.test/npm/@babel%2fcore',
      'https://registry.test/npm/JSONStream',
      `https://registry.test/npm/${'a'.repeat(214)}`,
      'https://registry.test/npm/lodash.get',
    ]);
  });
});
