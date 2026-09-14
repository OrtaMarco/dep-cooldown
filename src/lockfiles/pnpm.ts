import { posix } from 'node:path';
import { parseAllDocuments } from 'yaml';
import type { ParsedLockfile } from '../types.js';
import { LockCollector, classifySpec, type SkipReason } from './resolved.js';

interface ImporterSpec {
  specifier?: string;
  version?: string;
}
type DepBlock = Record<string, ImporterSpec | string>;

interface Importer {
  dependencies?: DepBlock;
  devDependencies?: DepBlock;
  optionalDependencies?: DepBlock;
  // Only in the environment document pnpm 11+ writes first.
  configDependencies?: DepBlock;
  packageManagerDependencies?: DepBlock;
  // v5: specifiers live apart from the resolved versions.
  specifiers?: Record<string, string>;
}

interface PnpmPackage {
  dev?: boolean;
  name?: string;
  version?: string;
  resolution?: {
    tarball?: unknown;
    type?: unknown;
    commit?: unknown;
    directory?: unknown;
  };
}

interface PnpmLock extends Importer {
  lockfileVersion?: string | number;
  importers?: Record<string, Importer>;
  packages?: Record<string, PnpmPackage | null>;
  snapshots?: Record<string, PnpmPackage | null>;
}

/**
 * v5 key after the leading slash: `name/1.2.3` or `@scope/name/1.2.3`, then an
 * optional `_peer@1.0.0+other@2.0.0` suffix. The version must look like semver
 * so that a git key such as `user/repo/0123abc` is not read as one.
 */
const V5_KEY =
  /^((?:@[^/@]+\/)?[^/@]+)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:_.+)?$/;

/**
 * Turns a pnpm package key into `{name, version}`.
 *
 * Handles the three shapes pnpm has shipped:
 *   v9  `@scope/name@1.2.3(peer@4.5.6)`
 *   v6  `/@scope/name@1.2.3(peer@4.5.6)`
 *   v5  `/@scope/name/1.2.3_peer@4.5.6`
 *
 * The v5 shape is tried first: its peer suffix carries `@`, which the v6/v9
 * split would otherwise cut on (`/fresh/1.0.0_ms@2.1.3` as `fresh/1.0.0_ms`).
 */
export function parsePnpmKey(key: string): { name: string; version: string } | null {
  let k = key.startsWith('/') ? key.slice(1) : key;
  // A registry URL prefix can precede the name in some lockfiles.
  const registryPrefix = k.match(/^(?:[a-z]+:\/\/)?[^/]+\.[a-z]{2,}\/(?=@|[a-z])/i);
  if (registryPrefix && !k.startsWith('@')) k = k.slice(registryPrefix[0].length);

  const v5 = k.match(V5_KEY);
  if (v5) return { name: v5[1]!, version: v5[2]! };

  // Peer-dependency suffix: `foo@1.0.0(bar@2.0.0)`.
  const paren = k.indexOf('(');
  if (paren !== -1) k = k.slice(0, paren);

  const at = k.indexOf('@', 1);
  if (at > 0) {
    const name = k.slice(0, at);
    const version = k.slice(at + 1);
    if (/^\d/.test(version)) return { name, version };
  }
  return null; // git, file:, link:, tarball URLs — nothing to look up.
}

/** `name@locator` -> `{name, locator}`; a key with no `@name` part is all locator. */
function splitKey(key: string): { name: string; locator: string } {
  const k = key.startsWith('/') ? key.slice(1) : key;
  const at = k.indexOf('@', 1);
  return at > 0 ? { name: k.slice(0, at), locator: k.slice(at + 1) } : { name: k, locator: k };
}

/**
 * Why a `packages` entry has no registry date, or `null` when it is a registry
 * package. The resolution is read first: v5/v6 git and tarball keys can look
 * like `name/version`.
 */
function nonRegistryReason(parsed: boolean, key: string, pkg: PnpmPackage): SkipReason | null {
  const res = pkg.resolution ?? {};
  if (res.type === 'git' || typeof res.commit === 'string') return 'git';
  if (res.type === 'directory' || typeof res.directory === 'string') return 'file';
  if (parsed) return null;
  if (typeof res.tarball === 'string') return classifySpec(res.tarball) ?? 'tarball';
  return classifySpec(splitKey(key).locator) ?? 'other';
}

const DEP_BLOCKS = [
  ['dependencies', false],
  ['optionalDependencies', false],
  ['configDependencies', false],
  ['packageManagerDependencies', false],
  ['devDependencies', true],
] as const;

/**
 * pnpm 11+ can write two YAML documents into one `pnpm-lock.yaml`: first an
 * environment lockfile (`configDependencies`, and the pnpm binary itself under
 * `packageManagerDependencies` when `packageManager` pins it), then the project
 * lockfile. Both resolve real versions from the registry, so both are audited.
 */
function readDocuments(raw: string): PnpmLock[] {
  const locks: PnpmLock[] = [];
  for (const doc of parseAllDocuments(raw)) {
    const [error] = doc.errors;
    if (error) throw error;
    const value = doc.toJS() as PnpmLock | null;
    if (value && typeof value === 'object') locks.push(value);
  }
  return locks;
}

/** Parses `pnpm-lock.yaml`, lockfile versions 5.x, 6.x and 9.x. */
export function parsePnpmLock(raw: string, path: string, mtime: string): ParsedLockfile {
  const locks = readDocuments(raw);
  // The project document comes last; the environment one carries the same version.
  const rawVersion = String(locks.at(-1)?.lockfileVersion ?? '');
  const major = rawVersion.split('.')[0] ?? '?';
  // v5 and v6 write `dev: true` or `dev: false` for packages used by one side
  // only, and omit it for packages both sides use.
  const legacyDevFlags = Number(major) <= 6;

  const out = new LockCollector();
  const direct = new Set<string>();
  const prodNames = new Set<string>();
  const devNames = new Set<string>();
  const sources: Record<string, PnpmPackage | null>[] = [];

  const importersOf = (lock: PnpmLock): [string, Importer][] =>
    // Single-project v5/v6 lockfiles keep the root importer at the top level.
    lock.importers ? Object.entries(lock.importers) : [['.', lock]];
  const importerIds = new Set(locks.flatMap((lock) => importersOf(lock).map(([id]) => posix.normalize(id))));

  for (const lock of locks) {
    for (const [id, imp] of importersOf(lock)) {
      for (const [field, isDev] of DEP_BLOCKS) {
        for (const [alias, spec] of Object.entries(imp[field] ?? {})) {
          const version = typeof spec === 'string' ? spec : spec?.version;
          if (typeof version !== 'string') continue;
          const specifier = typeof spec === 'string' ? imp.specifiers?.[alias] : spec?.specifier;
          if (version.startsWith('link:')) {
            const target = posix.normalize(posix.join(id, version.slice('link:'.length)));
            const toWorkspace = specifier?.startsWith('workspace:') || importerIds.has(target);
            out.skip(alias, version, toWorkspace ? 'workspace' : 'link');
            continue;
          }
          // An alias resolves to `real@1.2.3` (v6+) or `/real/1.2.3` (v5).
          const name = /^\d/.test(version) ? alias : (parsePnpmKey(version)?.name ?? alias);
          direct.add(name);
          (isDev ? devNames : prodNames).add(name);
        }
      }
    }
    // v9 moved the resolved set to `snapshots`, but `packages` still lists every
    // package@version once, which is exactly what we need.
    const source = lock.packages ?? lock.snapshots;
    if (source) sources.push(source);
  }

  for (const [key, node] of sources.flatMap((source) => Object.entries(source))) {
    const pkg: PnpmPackage = node && typeof node === 'object' ? node : {};
    const parsed = parsePnpmKey(key);
    const reason = nonRegistryReason(parsed !== null, key, pkg);
    if (!parsed || reason) {
      const tarball = pkg.resolution?.tarball;
      out.skip(
        pkg.name ?? splitKey(key).name,
        typeof tarball === 'string' ? tarball : splitKey(key).locator,
        reason ?? 'other',
      );
      continue;
    }
    const isDirect = direct.has(parsed.name);
    let dev: boolean | null = null;
    if (typeof pkg.dev === 'boolean') {
      dev = pkg.dev;
    } else if (legacyDevFlags) {
      dev = false;
    } else if (isDirect) {
      // v9 dropped the flag: only the importers can speak, for direct packages.
      // One importer needing it in production keeps it out of `--prod` drops.
      dev = devNames.has(parsed.name) && !prodNames.has(parsed.name);
    }
    const tarball = pkg.resolution?.tarball;
    out.addResolved(
      { name: parsed.name, version: parsed.version, direct: isDirect, dev },
      typeof tarball === 'string' ? tarball : undefined,
    );
  }

  return {
    manager: 'pnpm',
    path,
    format: `pnpm-lock.yaml v${major}`,
    mtime,
    entries: out.entries,
    skipped: out.skipped,
  };
}
