import type { LockEntry, ParsedLockfile } from '../types.js';

interface NpmPackageNode {
  name?: string;
  version?: string;
  dev?: boolean;
  devOptional?: boolean;
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface NpmV1Node {
  version?: string;
  dev?: boolean;
  resolved?: string;
  dependencies?: Record<string, NpmV1Node>;
}

interface NpmLock {
  lockfileVersion?: number;
  packages?: Record<string, NpmPackageNode>;
  dependencies?: Record<string, NpmV1Node>;
}

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b`. */
function nameFromPath(path: string): string | null {
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const name = path.slice(at + marker.length);
  return name.length > 0 ? name : null;
}

/**
 * Parses `package-lock.json`. Handles lockfileVersion 2 and 3 through the
 * `packages` map, and falls back to the legacy `dependencies` tree so that
 * v1 lockfiles and `npm-shrinkwrap.json` still produce something useful.
 */
export function parseNpmLock(raw: string, path: string, mtime: string): ParsedLockfile {
  const lock = JSON.parse(raw) as NpmLock;
  const version = lock.lockfileVersion ?? 1;
  const entries: LockEntry[] = [];
  const seen = new Set<string>();

  const push = (name: string, ver: string, dev: boolean | null, direct: boolean) => {
    const key = `${name}@${ver}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name, version: ver, direct, dev });
  };

  if (lock.packages) {
    const root = lock.packages[''] ?? {};
    const directNames = new Set<string>([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
      ...Object.keys(root.optionalDependencies ?? {}),
      ...Object.keys(root.peerDependencies ?? {}),
    ]);

    for (const [key, node] of Object.entries(lock.packages)) {
      if (key === '') continue;
      // Workspace members are symlinks into the repo, not registry downloads.
      if (node.link) continue;
      const name = node.name ?? nameFromPath(key);
      if (!name || !node.version) continue;
      // Anything not resolved from a registry (git, file:, workspace) has no
      // publish date to look up.
      if (node.resolved && !/^https?:/.test(node.resolved)) continue;
      const dev = node.dev === true || node.devOptional === true;
      push(name, node.version, dev, directNames.has(name));
    }
  } else if (lock.dependencies) {
    const directNames = new Set(Object.keys(lock.dependencies));
    const walk = (tree: Record<string, NpmV1Node>, depth: number) => {
      for (const [name, node] of Object.entries(tree)) {
        if (node.version && /^\d/.test(node.version)) {
          push(name, node.version, node.dev === true, depth === 0 && directNames.has(name));
        }
        if (node.dependencies) walk(node.dependencies, depth + 1);
      }
    };
    walk(lock.dependencies, 0);
  }

  return {
    manager: 'npm',
    path,
    format: `package-lock.json v${version}`,
    mtime,
    entries,
  };
}
