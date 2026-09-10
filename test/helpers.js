import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');

/** The date every deterministic assertion is measured against. */
export const AS_OF = new Date('2026-09-09T00:00:00.000Z');

export function fixture(...parts) {
  return join(FIXTURES, ...parts);
}

export function readFixture(...parts) {
  return readFileSync(fixture(...parts), 'utf8');
}

/**
 * A `fetch` stand-in backed by `test/fixtures/registry/*.json`, so the unit
 * tests never leave the machine. Also records what was requested, which is how
 * the concurrency and dedupe tests observe the client.
 */
export function mockRegistry({ fail = new Set(), missing = new Set() } = {}) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;

  const impl = async (url) => {
    calls.push(url);
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Yield so several requests really do overlap.
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;

    const name = decodeURIComponent(url.slice(url.indexOf('/', 'https://'.length) + 1));
    if (missing.has(name)) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    }
    if (fail.has(name)) {
      return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) };
    }
    try {
      const raw = readFixture('registry', `${name.replace('/', '__')}.json`);
      return { ok: true, status: 200, json: async () => JSON.parse(raw) };
    } catch {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    }
  };

  return {
    impl,
    calls,
    get peakConcurrency() {
      return peak;
    },
  };
}

/** An in-memory cache, so tests never touch `~/.cache`. */
export function memoryCache() {
  const store = new Map();
  return {
    store,
    async get(registry, name, maxAgeMs) {
      const hit = store.get(`${registry}|${name}`);
      if (!hit) return null;
      if (maxAgeMs !== Infinity && Date.now() - Date.parse(hit.fetchedAt) > maxAgeMs) return null;
      return hit;
    },
    async set(registry, name, meta) {
      store.set(`${registry}|${name}`, meta);
    },
  };
}

export const NO_NPMRC = {
  default: 'https://registry.npmjs.org',
  scoped: new Map(),
  source: 'test',
};
