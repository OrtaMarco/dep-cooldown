import type { LockEntry, ParsedLockfile } from '../types.js';

/** `"@scope/name@npm:^1.0.0"` or `name@^1.0.0` -> `@scope/name`. */
function nameFromDescriptor(descriptor: string): string | null {
  let d = descriptor.trim();
  if (d.startsWith('"') && d.endsWith('"')) d = d.slice(1, -1);
  const at = d.lastIndexOf('@');
  if (at <= 0) return d.length > 0 ? d : null;
  return d.slice(0, at);
}

/** Berry's `resolution: "@scope/name@npm:1.2.3"` -> `{name, version}`. */
function fromResolution(resolution: string): { name: string; version: string } | null {
  let r = resolution.trim();
  if (r.startsWith('"') && r.endsWith('"')) r = r.slice(1, -1);
  const at = r.lastIndexOf('@');
  if (at <= 0) return null;
  const name = r.slice(0, at);
  const locator = r.slice(at + 1);
  // Only `npm:` locators live in a registry; workspace/patch/link/portal/git do not.
  if (!locator.startsWith('npm:')) return null;
  const version = locator.slice('npm:'.length);
  if (!/^\d/.test(version)) return null;
  return { name, version };
}

/**
 * Parses `yarn.lock`, both the Yarn 1 "classic" custom format and the Yarn 2+
 * ("Berry") YAML-ish one. Both are line-oriented enough that one small
 * state machine handles them, which keeps the dependency list at zero.
 *
 * `directNames` should be the union of the root manifest's dependency fields:
 * neither format records which entries are direct.
 */
export function parseYarnLock(
  raw: string,
  path: string,
  mtime: string,
  directNames: Set<string>,
  directDevNames: Set<string> = new Set(),
): ParsedLockfile {
  const isBerry = /^__metadata:/m.test(raw);
  const lines = raw.split(/\r?\n/);

  const entries: LockEntry[] = [];
  const seen = new Set<string>();
  let descriptors: string[] = [];
  let version: string | null = null;
  let resolution: string | null = null;

  const flush = () => {
    if (descriptors.length > 0) {
      let name: string | null = null;
      let ver: string | null = null;
      if (isBerry && resolution) {
        const r = fromResolution(resolution);
        if (r) {
          name = r.name;
          ver = r.version;
        }
      } else if (version) {
        name = nameFromDescriptor(descriptors[0]!);
        ver = version;
      }
      if (name && ver && /^\d/.test(ver)) {
        const id = `${name}@${ver}`;
        if (!seen.has(id)) {
          seen.add(id);
          const direct = descriptors.some((d) => {
            const n = nameFromDescriptor(d);
            return n !== null && directNames.has(n);
          });
          // Yarn records no dev flag for transitive packages; only the root
          // manifest can tell us, and only about direct dependencies.
          const dev = direct ? directDevNames.has(name) : null;
          entries.push({ name, version: ver, direct, dev });
        }
      }
    }
    descriptors = [];
    version = null;
    resolution = null;
  };

  for (const line of lines) {
    if (line.length === 0 || line.trimStart().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      flush();
      if (!line.trimEnd().endsWith(':')) continue;
      const header = line.trimEnd().slice(0, -1);
      if (header === '__metadata') continue;
      descriptors = header.split(',').map((d) => d.trim()).filter(Boolean);
      continue;
    }
    const trimmed = line.trim();
    // Classic: `version "1.2.3"`. Berry: `version: 1.2.3`.
    const v = trimmed.match(/^version:?\s+"?([^"\s]+)"?$/);
    if (v) {
      version = v[1]!;
      continue;
    }
    const r = trimmed.match(/^resolution:\s+(.+)$/);
    if (r) resolution = r[1]!;
  }
  flush();

  return {
    manager: 'yarn',
    path,
    format: isBerry ? 'yarn.lock (Berry)' : 'yarn.lock (classic v1)',
    mtime,
    entries,
  };
}
