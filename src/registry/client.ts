import type { PackageMeta, VersionMeta } from '../types.js';
import { type Cache, diskCache, nullCache } from './cache.js';
import { type RegistryConfig, registryFor } from './npmrc.js';

/** Anything shaped like `fetch`, so tests can hand in a mock registry. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
}>;

export interface ClientOptions {
  config: RegistryConfig;
  cache?: Cache;
  /** Never hit the network; serve whatever the cache has. */
  offline?: boolean;
  concurrency?: number;
  /** How long a cached record stays fresh. `Infinity` when offline. */
  ttlMs?: number;
  fetchImpl?: FetchLike;
  /** Called after each package resolves, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
}

export interface FetchOutcome {
  meta?: PackageMeta;
  error?: string;
  /** The record came from the on-disk cache, not the network. */
  cached: boolean;
}

interface RawPackument {
  name?: string;
  time?: Record<string, string>;
  versions?: Record<
    string,
    { deprecated?: string; dist?: { attestations?: unknown } }
  >;
}

/**
 * Keeps only the three things this tool reads. A full packument for a package
 * like `@types/node` is several megabytes; the trimmed record is a few dozen
 * kilobytes, and that is what lands in the cache.
 */
export function trimPackument(doc: RawPackument, name: string): PackageMeta {
  const time: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc.time ?? {})) {
    // `created`, `modified` and `unpublished` are not versions.
    if (key === 'created' || key === 'modified' || key === 'unpublished') continue;
    if (typeof value === 'string') time[key] = value;
  }
  const versions: Record<string, VersionMeta> = {};
  for (const [v, node] of Object.entries(doc.versions ?? {})) {
    const meta: VersionMeta = { provenance: node?.dist?.attestations != null };
    if (typeof node?.deprecated === 'string') meta.deprecated = node.deprecated;
    versions[v] = meta;
  }
  return { name: doc.name ?? name, time, versions, fetchedAt: new Date().toISOString() };
}

const DAY = 24 * 60 * 60 * 1000;

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createRegistryClient(options: ClientOptions) {
  const {
    config,
    offline = false,
    concurrency = 8,
    fetchImpl = globalThis.fetch as unknown as FetchLike,
  } = options;
  const cache = options.cache ?? (offline ? diskCache() : (options.cache ?? diskCache()));
  const ttlMs = offline ? Infinity : (options.ttlMs ?? DAY);

  async function one(name: string): Promise<FetchOutcome> {
    const registry = registryFor(name, config);
    const hit = await cache.get(registry, name, ttlMs);
    if (hit) return { meta: hit, cached: true };
    if (offline) {
      return { error: 'not in cache (--offline)', cached: false };
    }
    if (typeof fetchImpl !== 'function') {
      return { error: 'no fetch implementation available', cached: false };
    }

    // The abbreviated packument (application/vnd.npm.install-v1+json) omits
    // `time`, so the full document is the only way to learn publish dates.
    const url = `${registry}/${name.replace(/\//g, '%2f')}`;
    let lastError = 'unknown error';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(url, {
          headers: {
            accept: 'application/json',
            'user-agent': 'dep-cooldown (+https://github.com/OrtaMarco/dep-cooldown)',
          },
        });
        if (res.status === 404) return { error: 'not found in registry', cached: false };
        if (!res.ok) {
          lastError = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
          if (res.status < 500 && res.status !== 429) break;
        } else {
          const meta = trimPackument((await res.json()) as RawPackument, name);
          await cache.set(registry, name, meta);
          return { meta, cached: false };
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
    }
    // A network failure still has a shot at a stale cache entry.
    const stale = await cache.get(registry, name, Infinity);
    if (stale) return { meta: stale, cached: true };
    return { error: lastError, cached: false };
  }

  return {
    /** Fetches every name once, with bounded concurrency. */
    async fetchAll(names: string[]): Promise<Map<string, FetchOutcome>> {
      const unique = [...new Set(names)];
      let done = 0;
      const outcomes = await pool(unique, concurrency, async (name) => {
        const outcome = await one(name);
        options.onProgress?.(++done, unique.length);
        return outcome;
      });
      return new Map(unique.map((name, i) => [name, outcomes[i]!]));
    },
  };
}

export { nullCache };
