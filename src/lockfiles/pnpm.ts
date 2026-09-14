import { parseAllDocuments } from 'yaml';
import type { LockEntry, ParsedLockfile } from '../types.js';

interface ImporterSpec {
  specifier?: string;
  version?: string;
}
type DepBlock = Record<string, ImporterSpec | string>;

interface PnpmLock {
  lockfileVersion?: string | number;
  importers?: Record<
    string,
    {
      dependencies?: DepBlock;
      devDependencies?: DepBlock;
      optionalDependencies?: DepBlock;
      // Only in the environment document pnpm 11+ writes first.
      configDependencies?: DepBlock;
      packageManagerDependencies?: DepBlock;
    }
  >;
  dependencies?: DepBlock;
  devDependencies?: DepBlock;
  optionalDependencies?: DepBlock;
  packages?: Record<string, { dev?: boolean; resolution?: Record<string, unknown> }>;
  snapshots?: Record<string, unknown>;
}

/**
 * Turns a pnpm package key into `{name, version}`.
 *
 * Handles the three shapes pnpm has shipped:
 *   v9  `@scope/name@1.2.3(peer@4.5.6)`
 *   v6  `/@scope/name@1.2.3`
 *   v5  `/@scope/name/1.2.3`
 */
export function parsePnpmKey(key: string): { name: string; version: string } | null {
  let k = key.startsWith('/') ? key.slice(1) : key;
  // Peer-dependency suffix: `foo@1.0.0(bar@2.0.0)`.
  const paren = k.indexOf('(');
  if (paren !== -1) k = k.slice(0, paren);
  // A registry URL prefix can precede the name in some lockfiles.
  const registryPrefix = k.match(/^(?:[a-z]+:\/\/)?[^/]+\.[a-z]{2,}\/(?=@|[a-z])/i);
  if (registryPrefix && !k.startsWith('@')) k = k.slice(registryPrefix[0].length);

  const at = k.lastIndexOf('@');
  if (at > 0) {
    const name = k.slice(0, at);
    const version = k.slice(at + 1);
    if (/^\d/.test(version)) return { name, version };
    return null; // git:, file:, link:, https: — nothing to look up.
  }
  // v5 shape: split on the last slash.
  const slash = k.lastIndexOf('/');
  if (slash > 0) {
    const version = k.slice(slash + 1);
    if (/^\d/.test(version)) return { name: k.slice(0, slash), version };
  }
  return null;
}

function namesOf(block: DepBlock | undefined): string[] {
  return block ? Object.keys(block) : [];
}

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

  const direct = new Set<string>();
  const directDev = new Set<string>();
  const sources: Record<string, unknown>[] = [];
  for (const lock of locks) {
    for (const imp of Object.values(lock.importers ?? {})) {
      for (const n of namesOf(imp.dependencies)) direct.add(n);
      for (const n of namesOf(imp.optionalDependencies)) direct.add(n);
      for (const n of namesOf(imp.configDependencies)) direct.add(n);
      for (const n of namesOf(imp.packageManagerDependencies)) direct.add(n);
      for (const n of namesOf(imp.devDependencies)) {
        direct.add(n);
        directDev.add(n);
      }
    }
    for (const n of namesOf(lock.dependencies)) direct.add(n);
    for (const n of namesOf(lock.optionalDependencies)) direct.add(n);
    for (const n of namesOf(lock.devDependencies)) {
      direct.add(n);
      directDev.add(n);
    }
    // v9 moved the resolved set to `snapshots`, but `packages` still lists every
    // package@version once, which is exactly what we need.
    const source = lock.packages ?? lock.snapshots;
    if (source) sources.push(source);
  }

  const entries: LockEntry[] = [];
  const seen = new Set<string>();

  for (const [key, node] of sources.flatMap((source) => Object.entries(source))) {
    const parsed = parsePnpmKey(key);
    if (!parsed) continue;
    const id = `${parsed.name}@${parsed.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const isDirect = direct.has(parsed.name);
    // v6 and older tag every package with `dev`. v9 dropped it, so we can only
    // speak for the direct dependencies the importers declare.
    let dev: boolean | null = null;
    if (node && typeof (node as { dev?: boolean }).dev === 'boolean') {
      dev = (node as { dev: boolean }).dev;
    } else if (isDirect) {
      dev = directDev.has(parsed.name);
    }
    entries.push({ name: parsed.name, version: parsed.version, direct: isDirect, dev });
  }

  return {
    manager: 'pnpm',
    path,
    format: `pnpm-lock.yaml v${major}`,
    mtime,
    entries,
  };
}
