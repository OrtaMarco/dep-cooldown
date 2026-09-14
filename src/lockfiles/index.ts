import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

type Manifest = Record<string, unknown>;

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as unknown;
    return pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? (pkg as Manifest) : null;
  } catch {
    return null;
  }
}

/** `workspaces` as an array or as Yarn's `{ packages: [...] }`. */
function workspacePatterns(pkg: Manifest): string[] {
  const ws = pkg.workspaces;
  const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

const MAX_GLOB_DEPTH = 6;

/**
 * Expands workspace globs to directories. Supports what workspaces use in
 * practice: literal segments, `*` inside a segment and `**`; negations are
 * ignored. `node_modules` and dot-directories are never entered.
 */
async function expandWorkspaces(root: string, patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  const subdirs = async (dir: string): Promise<string[]> => {
    try {
      const items = await readdir(dir, { withFileTypes: true });
      return items
        .filter((d) => d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.'))
        .map((d) => join(dir, d.name));
    } catch {
      return [];
    }
  };

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const segments = pattern.replace(/^\.\//, '').split('/').filter((s) => s && s !== '.');
    let current = [root];
    for (const segment of segments) {
      const next: string[] = [];
      if (segment === '**') {
        let frontier = current;
        next.push(...current);
        for (let depth = 0; depth < MAX_GLOB_DEPTH && frontier.length > 0; depth++) {
          frontier = (await Promise.all(frontier.map(subdirs))).flat();
          next.push(...frontier);
        }
      } else if (segment.includes('*')) {
        const re = new RegExp(
          `^${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
        );
        for (const dir of current) {
          next.push(...(await subdirs(dir)).filter((d) => re.test(basename(d))));
        }
      } else if (segment !== '..') {
        next.push(...current.map((dir) => join(dir, segment)));
      }
      current = next;
    }
    for (const dir of current) if (dir !== root) found.add(dir);
  }
  return [...found];
}

/**
 * The names the root manifest and every workspace manifest declare. `dev` keeps
 * only the names no manifest declares outside `devDependencies`: a package that
 * is dev at the root and a dependency of a workspace ships in production.
 */
async function readManifestDirectNames(
  dir: string,
): Promise<{ direct: Set<string>; dev: Set<string> }> {
  const direct = new Set<string>();
  const prod = new Set<string>();
  const devOnly = new Set<string>();
  const root = await readManifest(dir);
  // No manifest: every entry stays transitive rather than failing the run.
  if (!root) return { direct, dev: devOnly };

  const members = await Promise.all(
    (await expandWorkspaces(dir, workspacePatterns(root))).map(readManifest),
  );
  for (const pkg of [root, ...members]) {
    if (!pkg) continue;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      const block = pkg[field];
      if (!block || typeof block !== 'object') continue;
      for (const n of Object.keys(block)) {
        direct.add(n);
        (field === 'devDependencies' ? devOnly : prod).add(n);
      }
    }
  }
  for (const n of prod) devOnly.delete(n);
  return { direct, dev: devOnly };
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
