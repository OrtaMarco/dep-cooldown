import type { PackageMeta, VersionMeta } from '../types.js';
import { type Cache, diskCache, nullCache } from './cache.js';
import { type RegistryConfig, redactRegistryUrl, registryFor } from './npmrc.js';

/** The part of a `fetch` Response the client reads. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  /** Needed for `location` on redirects and the `content-length` precheck. */
  headers?: { get(name: string): string | null };
  /**
   * Read in chunks so the byte cap holds. Mocks may leave it out and provide
   * `text()` or `json()` instead; the cap then applies after the fact
   * (`text`) or not at all (`json`).
   */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
    cancel?(reason?: unknown): Promise<void>;
  } | null;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

/**
 * Anything shaped like `fetch`, so tests can hand in a mock registry. The
 * client passes `redirect: 'manual'` and follows redirects itself; an
 * implementation that follows them on its own bypasses the same-origin rule.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' },
) => Promise<FetchResponseLike>;

export interface ClientOptions {
  config: RegistryConfig;
  cache?: Cache;
  /** Never hit the network; serve whatever the cache has. */
  offline?: boolean;
  /** Parallel requests. An integer >= 1; anything else throws a RangeError. Default 8. */
  concurrency?: number;
  /** How long a cached record stays fresh. `Infinity` when offline. */
  ttlMs?: number;
  /** One HTTP attempt, body included. Default 30 s. */
  timeoutMs?: number;
  /** Every attempt, retry and backoff for one package together. Default 60 s. */
  deadlineMs?: number;
  /** Largest packument body read, in bytes after decompression. Default 128 MiB. */
  maxBytes?: number;
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

/**
 * The largest full packument measured on registry.npmjs.org on 2026-09-14 is
 * `renovate` at 66.2 MiB (then `@prisma/client` 65.3 MiB, `sanity` 47.5 MiB,
 * `vite` 37.1 MiB; `typescript` 15 MiB, `@types/node` 10.6 MiB), growing about
 * 20 MiB a year. 128 MiB is roughly twice the largest and a few years of that
 * growth, while a hostile body stops well before the 1.35 GB RSS a 300 MB one
 * reached.
 */
export const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
/**
 * `renovate` (3.2 MB gzipped, 69 MB raw) downloads in about a second on a
 * normal link; 30 s leaves room for a link some 25 times slower.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** One timed-out attempt plus a retry, and a package never holds a worker longer. */
export const DEFAULT_DEADLINE_MS = 60_000;

const MAX_REDIRECTS = 5;
const ATTEMPTS = 3;

/** A failure with a message written here, never with bytes from the server. */
class PackageError extends Error {
  constructor(
    message: string,
    readonly retry = false,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keeps only the three things this tool reads. A full packument for a package
 * like `@types/node` is several megabytes; the trimmed record is a few dozen
 * kilobytes, and that is what lands in the cache.
 *
 * Throws when the document is not a packument for `name`: not an object, a
 * different `name`, no `time` map, or a `versions` that is not a map. The maps
 * it returns have no prototype, so a version called `constructor` or
 * `__proto__` is just a key.
 */
export function trimPackument(doc: unknown, name: string): PackageMeta {
  if (!isRecord(doc)) throw new PackageError('registry document is not a packument');
  if (doc.name !== name) throw new PackageError('registry document is for a different package');
  if (!isRecord(doc.time)) throw new PackageError('registry document has no publish dates (time)');
  if (doc.versions !== undefined && !isRecord(doc.versions)) {
    throw new PackageError('registry document is not a packument');
  }

  const time: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(doc.time)) {
    // `created`, `modified` and `unpublished` are not versions.
    if (key === 'created' || key === 'modified' || key === 'unpublished') continue;
    if (typeof value === 'string') time[key] = value;
  }
  const versions: Record<string, VersionMeta> = Object.create(null);
  for (const [v, node] of Object.entries(doc.versions ?? {})) {
    const record = isRecord(node) ? node : {};
    const dist = isRecord(record.dist) ? record.dist : {};
    const meta: VersionMeta = { provenance: dist.attestations != null };
    if (typeof record.deprecated === 'string') meta.deprecated = record.deprecated;
    versions[v] = meta;
  }
  return { name, time, versions, fetchedAt: new Date().toISOString() };
}

/**
 * npm's rules for a name that can be installed from a registry, as
 * validate-npm-package-name judges old packages: not empty, no leading `.` or
 * `_`, no surrounding spaces, not `node_modules` or `favicon.ico`, and only
 * URL-safe characters, with one optional `@scope/`. Capitals and `~'!()*` are
 * only warnings there, and real lockfiles carry them (`JSONStream`), so they
 * pass. Stricter than npm: at most 214 characters, and the scope may not
 * start with `.` either, so neither half can be a `.`/`..` path segment.
 */
export function isValidPackageName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false;
  if (name === 'node_modules' || name === 'favicon.ico' || name.startsWith('_')) return false;
  let scope: string | undefined;
  let pkg = name;
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash === -1) return false;
    scope = name.slice(1, slash);
    pkg = name.slice(slash + 1);
  }
  for (const part of scope === undefined ? [pkg] : [scope, pkg]) {
    if (part.length === 0 || part.startsWith('.') || encodeURIComponent(part) !== part) return false;
  }
  return true;
}

/** `https://host/prefix/@scope%2fname`, without userinfo, query or fragment. */
function packageUrl(registry: string, name: string): URL {
  const url = new URL(registry);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('protocol');
  // The tool never sends credentials: userinfo in the registry URL is dropped.
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const encoded = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1, name.indexOf('/')))}%2f${encodeURIComponent(name.slice(name.indexOf('/') + 1))}`
    : encodeURIComponent(name);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encoded}`;
  return url;
}

/**
 * Redirects are followed only within the same origin, plus the one upgrade
 * `http://host` -> `https://host` on default ports (registry.npmjs.org
 * answers plain http with exactly that 301). Any other host would be a
 * registry nobody configured deciding publish dates, so it is refused.
 */
function redirectAllowed(from: URL, to: URL): boolean {
  if (to.origin === from.origin) return true;
  return (
    from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    to.hostname === from.hostname &&
    from.port === '' &&
    to.port === ''
  );
}

function sizeLabel(bytes: number): string {
  const MiB = 1024 * 1024;
  return bytes % MiB === 0 ? `${bytes / MiB} MiB` : `${bytes} bytes`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** A network error code such as `ECONNREFUSED`, never free text. */
function errorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (isRecord(current)) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
    const errors = (current as { errors?: unknown }).errors;
    current = (current as { cause?: unknown }).cause ?? (Array.isArray(errors) ? errors[0] : undefined);
  }
  return undefined;
}

type Body = { text: string } | { parsed: unknown };

async function readBody(
  res: FetchResponseLike,
  maxBytes: number,
  abort: () => void,
  tooLarge: () => PackageError,
): Promise<Body> {
  const declared = Number(res.headers?.get('content-length') ?? Number.NaN);
  // With gzip the header is the compressed length, which the decoded body only
  // undercuts by a few bytes of framing on incompressible data.
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort();
    throw tooLarge();
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        abort();
        reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks, total).toString('utf8') };
  }
  if (typeof res.text === 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLarge();
    return { text };
  }
  if (typeof res.json === 'function') return { parsed: await res.json() };
  throw new PackageError('registry response has no body');
}

function positiveInteger(value: unknown, option: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${option} must be an integer >= 1, got ${String(value)}`);
  }
  return value;
}

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

const DAY = 24 * 60 * 60 * 1000;

/**
 * Error messages built here carry numbers and text written in this file, plus
 * the registry as `redactRegistryUrl` shows it: never a reason phrase, a body,
 * a `Location` header or a parser message, all of which the server chooses.
 */
export function createRegistryClient(options: ClientOptions) {
  const {
    config,
    offline = false,
    fetchImpl = globalThis.fetch as unknown as FetchLike,
  } = options;
  const concurrency = positiveInteger(options.concurrency ?? 8, 'concurrency');
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const deadlineMs = positiveInteger(options.deadlineMs ?? DEFAULT_DEADLINE_MS, 'deadlineMs');
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
  const cache = options.cache ?? diskCache();
  const ttlMs = offline ? Infinity : (options.ttlMs ?? DAY);

  /** One attempt, redirects included, within `ms`. Resolves to the packument. */
  async function attempt(start: URL, name: string, shown: string, ms: number, finalTry: boolean) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    try {
      let url = start;
      for (let hop = 0; ; hop++) {
        const res = await fetchImpl(url.href, {
          headers: {
            accept: 'application/json',
            'user-agent': 'dep-cooldown (+https://github.com/OrtaMarco/dep-cooldown)',
          },
          signal: controller.signal,
          redirect: 'manual',
        });
        const status = Number.isInteger(res.status) ? res.status : 0;

        if ([301, 302, 303, 307, 308].includes(status)) {
          res.body?.cancel?.().catch(() => undefined);
          if (hop >= MAX_REDIRECTS) throw new PackageError(`too many redirects from ${shown}`);
          const location = res.headers?.get('location');
          let next: URL | undefined;
          try {
            next = location ? new URL(location, url) : undefined;
          } catch {
            next = undefined;
          }
          if (!next) throw new PackageError(`invalid redirect from ${shown}`);
          if (!redirectAllowed(url, next)) {
            throw new PackageError(`redirect to another host refused (${shown})`);
          }
          next.username = '';
          next.password = '';
          next.hash = '';
          url = next;
          continue;
        }
        if (status === 404) {
          res.body?.cancel?.().catch(() => undefined);
          return { notFound: true as const };
        }
        if (!res.ok) {
          res.body?.cancel?.().catch(() => undefined);
          const retry = status >= 500 || status === 429;
          throw new PackageError(`HTTP ${status || 'error'} from ${shown}`, retry);
        }

        const body = await readBody(
          res,
          maxBytes,
          () => controller.abort(),
          () => new PackageError(`registry document larger than ${sizeLabel(maxBytes)} (${shown})`),
        );
        let doc: unknown;
        if ('parsed' in body) {
          doc = body.parsed;
        } else {
          try {
            doc = JSON.parse(body.text);
          } catch {
            throw new PackageError(`registry answered with invalid JSON (${shown})`);
          }
        }
        return { meta: trimPackument(doc, name) };
      }
    } catch (err) {
      if (err instanceof PackageError) throw err;
      if (timedOut) {
        const message = finalTry
          ? `gave up after ${seconds(deadlineMs)} waiting for ${shown}`
          : `timed out after ${seconds(ms)} waiting for ${shown}`;
        throw new PackageError(message, true);
      }
      const code = errorCode(err);
      throw new PackageError(`network error reaching ${shown}${code ? ` (${code})` : ''}`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function one(name: string): Promise<FetchOutcome> {
    // Checked before the cache and the network: an invalid name makes no request.
    if (!isValidPackageName(name)) return { error: 'invalid package name', cached: false };
    const registry = registryFor(name, config);
    const hit = await cache.get(registry, name, ttlMs);
    if (hit) return { meta: hit, cached: true };
    if (offline) {
      return { error: 'not in cache (--offline)', cached: false };
    }
    if (typeof fetchImpl !== 'function') {
      return { error: 'no fetch implementation available', cached: false };
    }

    const shown = redactRegistryUrl(registry);
    // The abbreviated packument (application/vnd.npm.install-v1+json) omits
    // `time`, so the full document is the only way to learn publish dates.
    let url: URL;
    try {
      url = packageUrl(registry, name);
    } catch {
      return { error: `invalid registry URL (${shown})`, cached: false };
    }

    const deadline = Date.now() + deadlineMs;
    let lastError = 'unknown error';
    for (let i = 0; i < ATTEMPTS; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const ms = Math.min(timeoutMs, remaining);
      try {
        const result = await attempt(url, name, shown, ms, ms === remaining);
        if ('notFound' in result) return { error: 'not found in registry', cached: false };
        await cache.set(registry, name, result.meta);
        return { meta: result.meta, cached: false };
      } catch (err) {
        const failure =
          err instanceof PackageError ? err : new PackageError(`request to ${shown} failed`);
        lastError = failure.message;
        if (!failure.retry) break;
      }
      if (i < ATTEMPTS - 1) {
        const wait = Math.min(150 * 2 ** i, deadline - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
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
