import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PackageMeta, VersionMeta } from '../types.js';

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

/**
 * Every name this cache writes: an entry from `keyFor`, or a temporary file
 * next to one (`<entry>.<32 hex>.tmp` now, `<entry>.<pid>.tmp` before).
 * `clearCache` deletes nothing else.
 */
const OWN_FILE = /^[a-zA-Z0-9._-]{0,40}-[0-9a-f]{16}\.json(?:\.(?:[0-9a-f]{32}|\d+)\.tmp)?$/;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds a cached record from untrusted JSON, or returns `null` when it does
 * not have the shape `trimPackument` writes. The maps come back without a
 * prototype, like the ones the client builds.
 */
function parseCachedMeta(value: unknown, name: string): PackageMeta | null {
  if (!isRecord(value)) return null;
  if (value.name !== name) return null;
  if (typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt))) return null;
  if (!isRecord(value.time) || !isRecord(value.versions)) return null;

  const time: Record<string, string> = Object.create(null);
  for (const [version, date] of Object.entries(value.time)) {
    if (typeof date !== 'string') return null;
    time[version] = date;
  }
  const versions: Record<string, VersionMeta> = Object.create(null);
  for (const [version, node] of Object.entries(value.versions)) {
    if (!isRecord(node) || typeof node.provenance !== 'boolean') return null;
    const meta: VersionMeta = { provenance: node.provenance };
    if (node.deprecated !== undefined) {
      if (typeof node.deprecated !== 'string') return null;
      meta.deprecated = node.deprecated;
    }
    versions[version] = meta;
  }
  return { name, time, versions, fetchedAt: value.fetchedAt };
}

export function diskCache(dir = cacheDir()): Cache {
  let ready: Promise<void> | null = null;
  const ensure = () =>
    (ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined));

  return {
    async get(registry, name, maxAgeMs) {
      let meta: PackageMeta | null;
      try {
        const raw = await readFile(join(dir, keyFor(registry, name)), 'utf8');
        meta = parseCachedMeta(JSON.parse(raw), name);
      } catch {
        return null;
      }
      if (!meta) return null;
      if (maxAgeMs !== Infinity) {
        const age = Date.now() - Date.parse(meta.fetchedAt);
        // An entry stamped in the future cannot be trusted to be fresh.
        if (age < 0 || age > maxAgeMs) return null;
      }
      return meta;
    },
    async set(registry, name, meta) {
      let tmp: string | undefined;
      try {
        await ensure();
        const file = join(dir, keyFor(registry, name));
        // Write-then-rename so a killed process cannot leave half a JSON file.
        // The temporary name is unpredictable and opened with O_EXCL ('wx'),
        // so a symlink planted in the directory is never followed.
        tmp = `${file}.${randomBytes(16).toString('hex')}.tmp`;
        const handle = await open(tmp, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(meta), 'utf8');
        } finally {
          await handle.close();
        }
        await rename(tmp, file);
        tmp = undefined;
      } catch {
        // A cache that cannot be written is not a reason to fail the audit.
        if (tmp) await unlink(tmp).catch(() => undefined);
      }
    },
  };
}

/**
 * Deletes the files this cache wrote, then the directory if nothing else is
 * left in it. Anything else — other files, subdirectories, symlinks (even ones
 * named like an entry) — stays, and no symlink is followed: a directory that
 * is itself a symlink is left alone. `DEP_COOLDOWN_CACHE_DIR=$HOME` therefore
 * cannot turn `--clear-cache` into `rm -rf $HOME`.
 */
export async function clearCache(
  dir = cacheDir(),
): Promise<{ removed: number; kept: number; removedDir: boolean }> {
  const result = { removed: 0, kept: 0, removedDir: false };
  try {
    if (!(await lstat(dir)).isDirectory()) return result;
  } catch {
    return result;
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (info.isFile() && OWN_FILE.test(name)) {
        // unlink never follows a symlink, even one swapped in after lstat.
        await unlink(path);
        result.removed++;
      } else {
        result.kept++;
      }
    } catch {
      result.kept++;
    }
  }
  if (result.kept === 0) {
    try {
      await rmdir(dir);
      result.removedDir = true;
    } catch {
      // Something appeared meanwhile, or the directory is not ours to remove.
    }
  }
  return result;
}
