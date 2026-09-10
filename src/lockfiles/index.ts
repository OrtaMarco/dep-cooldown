import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedLockfile } from '../types.js';
import { parseNpmLock } from './npm.js';
import { parsePnpmLock } from './pnpm.js';
import { parseYarnLock } from './yarn.js';
import { parseBunLock } from './bun.js';

export { parseNpmLock, parsePnpmLock, parseYarnLock, parseBunLock };
export { parsePnpmKey } from './pnpm.js';
export { stripJsonc } from './bun.js';

/**
 * Detection order. `bun.lock` first because a Bun project can also carry a
 * `yarn.lock` written for tooling compatibility, and `pnpm-lock.yaml` before
 * `package-lock.json` because pnpm repos sometimes keep a stale npm lockfile.
 */
const CANDIDATES = ['bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'] as const;

export class NoLockfileError extends Error {
  constructor(dir: string) {
    super(
      `No lockfile found in ${dir}. Looked for: ${CANDIDATES.join(', ')}.\n` +
        `Run dep-cooldown from a project root, or pass --cwd <dir>.`,
    );
    this.name = 'NoLockfileError';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifestDirectNames(
  dir: string,
): Promise<{ direct: Set<string>; dev: Set<string> }> {
  const direct = new Set<string>();
  const dev = new Set<string>();
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const n of Object.keys(pkg[field] ?? {})) direct.add(n);
    }
    for (const n of Object.keys(pkg.devDependencies ?? {})) {
      direct.add(n);
      dev.add(n);
    }
  } catch {
    // No manifest: every entry stays transitive rather than failing the run.
  }
  return { direct, dev };
}

/** Finds and parses the first supported lockfile in `dir`. */
export async function detectAndParse(dir: string, only?: string): Promise<ParsedLockfile> {
  const names = only ? [only] : CANDIDATES;
  for (const name of names) {
    const path = join(dir, name);
    if (!(await exists(path))) continue;
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const mtime = info.mtime.toISOString();

    if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
      return parseNpmLock(raw, path, mtime);
    }
    if (name === 'pnpm-lock.yaml') return parsePnpmLock(raw, path, mtime);
    if (name === 'bun.lock') return parseBunLock(raw, path, mtime);
    if (name === 'yarn.lock') {
      const { direct, dev } = await readManifestDirectNames(dir);
      return parseYarnLock(raw, path, mtime, direct, dev);
    }
  }
  throw new NoLockfileError(dir);
}
