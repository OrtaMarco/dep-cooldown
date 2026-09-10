import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PackageMeta } from '../types.js';

/** `~/.cache/dep-cooldown`, or `$XDG_CACHE_HOME/dep-cooldown`. */
export function cacheDir(): string {
  const override = process.env.DEP_COOLDOWN_CACHE_DIR;
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache'), 'dep-cooldown');
}

function keyFor(registry: string, name: string): string {
  const hash = createHash('sha256').update(`${registry}|${name}`).digest('hex').slice(0, 16);
  // Keep a readable prefix so the cache directory can be inspected by hand.
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  return `${safe}-${hash}.json`;
}

export interface Cache {
  get(registry: string, name: string, maxAgeMs: number): Promise<PackageMeta | null>;
  set(registry: string, name: string, meta: PackageMeta): Promise<void>;
}

/** A cache that never stores anything, for `--no-cache`. */
export const nullCache: Cache = {
  async get() {
    return null;
  },
  async set() {
    /* no-op */
  },
};

export function diskCache(dir = cacheDir()): Cache {
  let ready: Promise<void> | null = null;
  const ensure = () => (ready ??= mkdir(dir, { recursive: true }).then(() => undefined));

  return {
    async get(registry, name, maxAgeMs) {
      try {
        const raw = await readFile(join(dir, keyFor(registry, name)), 'utf8');
        const meta = JSON.parse(raw) as PackageMeta;
        if (!meta.fetchedAt) return null;
        if (maxAgeMs !== Infinity && Date.now() - Date.parse(meta.fetchedAt) > maxAgeMs) return null;
        return meta;
      } catch {
        return null;
      }
    },
    async set(registry, name, meta) {
      try {
        await ensure();
        const file = join(dir, keyFor(registry, name));
        // Write-then-rename so a killed process cannot leave half a JSON file.
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(meta), 'utf8');
        const { rename } = await import('node:fs/promises');
        await rename(tmp, file);
      } catch {
        // A cache that cannot be written is not a reason to fail the audit.
      }
    },
  };
}

export async function clearCache(dir = cacheDir()): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
