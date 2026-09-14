import type { ParsedLockfile, SkippedEntry } from '../types.js';
import { LockCollector, classifySpec } from './resolved.js';

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

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b`. */
function nameFromPath(path: string): string | null {
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const name = path.slice(at + marker.length);
  return name.length > 0 ? name : null;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** `npm:@scope/name@1.2.3` -> `{name, version}`. */
function splitAlias(spec: string): { name: string; version: string } | null {
  if (!spec.startsWith('npm:')) return null;
  const inner = spec.slice('npm:'.length);
  const at = inner.indexOf('@', 1);
  return at > 0 ? { name: inner.slice(0, at), version: inner.slice(at + 1) } : null;
}

/**
 * Parses `package-lock.json` and `npm-shrinkwrap.json`. Handles lockfileVersion
 * 2 and 3 through the `packages` map, and falls back to the legacy
 * `dependencies` tree so that v1 lockfiles still produce something useful.
 *
 * `resolved` is checked against `name@version`: npm installs what `resolved`
 * points at, whatever `version` says. When `resolved` is absent (v1 lockfiles,
 * `omit-lockfile-registry-resolved`) npm fetches `name@version` from the
 * configured registry, which is exactly what the audit dates.
 */
export function parseNpmLock(raw: string, path: string, mtime: string): ParsedLockfile {
  const lock = JSON.parse(raw) as NpmLock;
  const version = lock.lockfileVersion ?? 1;
  const out = new LockCollector();

  if (lock.packages) {
    const packages = Object.entries(lock.packages);
    const root = lock.packages[''] ?? {};
    const directNames = new Set<string>(DEP_FIELDS.flatMap((f) => Object.keys(root[f] ?? {})));

    // Every spec any package declares for a name, to tell `file:` links from workspaces.
    const specs = new Map<string, string[]>();
    for (const [, node] of packages) {
      for (const field of DEP_FIELDS) {
        for (const [dep, spec] of Object.entries(node[field] ?? {})) {
          specs.set(dep, [...(specs.get(dep) ?? []), spec]);
        }
      }
    }
    const linkReason = (name: string): SkippedEntry['reason'] => {
      const declared = specs.get(name) ?? [];
      if (declared.some((s) => s.startsWith('file:'))) return 'file';
      if (declared.some((s) => s.startsWith('link:'))) return 'link';
      return 'workspace';
    };

    // `link: true` entries are symlinks to a directory that is also a key of
    // its own (`packages/app`, `../lib`): workspace members and `file:` folders.
    const linkTargets = new Map<string, { name: string; reason: SkippedEntry['reason'] }>();
    for (const [key, node] of packages) {
      if (!node.link) continue;
      const name = nameFromPath(key) ?? node.name ?? basename(key);
      linkTargets.set(node.resolved ?? key, { name, reason: linkReason(name) });
    }

    for (const [key, node] of packages) {
      if (key === '') continue;
      const pathName = nameFromPath(key);

      if (node.link) {
        const target = node.resolved ?? key;
        const link = linkTargets.get(target)!;
        out.skip(link.name, target, link.reason);
        continue;
      }
      // Keys without `node_modules/` are folders in the repo, never downloads.
      if (pathName === null) {
        const link = linkTargets.get(key);
        if (link) out.skip(link.name, key, link.reason);
        else out.skip(node.name ?? basename(key), key, 'workspace');
        continue;
      }

      // `name` is set when the folder name is an alias (`"foo": "npm:bar@1"`).
      const name = node.name ?? pathName;
      if (!node.version || !/^\d/.test(node.version)) {
        const spec = node.resolved ?? node.version ?? key;
        out.skip(name, spec, classifySpec(spec) ?? 'other');
        continue;
      }
      out.addResolved(
        {
          name,
          version: node.version,
          direct: directNames.has(pathName) || directNames.has(name),
          // `devOptional` is not dev-only: `--omit=dev` still installs it.
          dev: node.dev === true,
        },
        node.resolved,
      );
    }
  } else if (lock.dependencies) {
    const directNames = new Set(Object.keys(lock.dependencies));
    const walk = (tree: Record<string, NpmV1Node>, depth: number) => {
      for (const [key, node] of Object.entries(tree)) {
        if (node.version) {
          const alias = splitAlias(node.version);
          const name = alias?.name ?? key;
          const ver = alias?.version ?? node.version;
          if (/^\d/.test(ver)) {
            out.addResolved(
              { name, version: ver, direct: depth === 0 && directNames.has(key), dev: node.dev === true },
              node.resolved,
            );
          } else {
            out.skip(key, node.version, classifySpec(node.version) ?? 'other');
          }
        }
        if (node.dependencies) walk(node.dependencies, depth + 1);
      }
    };
    walk(lock.dependencies, 0);
  }

  const file = path.endsWith('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : 'package-lock.json';
  return {
    manager: 'npm',
    path,
    format: `${file} v${version}`,
    mtime,
    entries: out.entries,
    skipped: out.skipped,
  };
}
