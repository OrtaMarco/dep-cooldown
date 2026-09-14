import type { ParsedLockfile, SkippedEntry } from '../types.js';
import { LockCollector, checkResolvedShape, classifySpec } from './resolved.js';

function unquote(value: string): string {
  const v = value.trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

/**
 * `name@range`, split at the first `@` after a possible scope, because the
 * range itself can carry `@`: `"foo@npm:bar@^1.0.0"` -> `foo` + `npm:bar@^1.0.0`.
 */
function splitDescriptor(descriptor: string): { name: string; range: string } {
  const d = unquote(descriptor);
  const at = d.indexOf('@', 1);
  return at > 0 ? { name: d.slice(0, at), range: d.slice(at + 1) } : { name: d, range: '' };
}

/** Classic alias: `foo@npm:@scope/bar@^1` is `@scope/bar@^1` under the name `foo`. */
function publishedTarget(descriptor: string): { declared: string; name: string; range: string } {
  const { name, range } = splitDescriptor(descriptor);
  if (!range.startsWith('npm:')) return { declared: name, name, range };
  const inner = splitDescriptor(range.slice('npm:'.length));
  return { declared: name, name: inner.name, range: inner.range };
}

type BerryTarget =
  | { kind: 'entry'; name: string; version: string; resolved?: string }
  | { kind: 'skip'; reason: SkippedEntry['reason'] }
  | { kind: 'root' };

/**
 * What a Berry `resolution` locator installs. `patch:` wraps another locator
 * (URL-encoded up to the `#`): a patch over a registry package audits that
 * package, since Berry downloads it from the registry and applies a diff kept in
 * the repo (and always locks the unpatched `npm:` entry next to it as well).
 */
function berryTarget(name: string, locator: string, version: string | null): BerryTarget {
  if (locator.startsWith('npm:')) {
    const v = locator.slice('npm:'.length);
    return /^\d/.test(v) ? { kind: 'entry', name, version: v } : { kind: 'skip', reason: 'other' };
  }
  if (locator.startsWith('patch:')) {
    const source = locator.slice('patch:'.length).split('#')[0]!;
    let decoded: string;
    try {
      decoded = decodeURIComponent(source);
    } catch {
      return { kind: 'skip', reason: 'other' };
    }
    const inner = splitDescriptor(decoded);
    const target = berryTarget(inner.name, inner.range, version);
    return target.kind === 'root' ? { kind: 'skip', reason: 'workspace' } : target;
  }
  if (locator.startsWith('workspace:')) {
    // The project being audited is not a dependency of itself.
    return locator === 'workspace:.' ? { kind: 'root' } : { kind: 'skip', reason: 'workspace' };
  }
  if (/^https?:\/\//i.test(locator)) {
    const shape = checkResolvedShape(name, version, locator);
    if (shape.kind === 'ok') return { kind: 'entry', name, version: shape.version, resolved: locator };
    // A mismatch still becomes an entry: the collector marks it unverifiable.
    if (shape.kind === 'mismatch' && version) return { kind: 'entry', name, version, resolved: locator };
    return { kind: 'skip', reason: shape.kind === 'skip' ? shape.reason : 'tarball' };
  }
  return { kind: 'skip', reason: classifySpec(locator) ?? 'other' };
}

/** Block fields sit at exactly two spaces; deeper lines belong to `dependencies:`. */
const FIELD = /^ {2}(version|resolved|resolution):?\s+(.+)$/;

/**
 * Parses `yarn.lock`, both the Yarn 1 "classic" custom format and the Yarn 2+
 * ("Berry") YAML-ish one. Both are line-oriented enough that one small
 * state machine handles them, which keeps the dependency list at zero.
 *
 * Neither format records which entries are direct, so the caller passes the
 * manifests' view: `directNames` is every name declared in a dependency field,
 * `directDevNames` the ones declared only in `devDependencies`.
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
  const out = new LockCollector();

  let descriptors: string[] = [];
  let version: string | null = null;
  let resolved: string | null = null;
  let resolution: string | null = null;

  const flush = () => {
    if (descriptors.length === 0) return;
    const targets = descriptors.map(publishedTarget);
    const declaredDirect = targets.map((t) => t.declared).filter((n) => directNames.has(n));
    const direct = declaredDirect.length > 0;
    // Yarn records no dev flag; only the manifests can tell, and only for
    // direct dependencies. One declaration outside devDependencies is enough.
    const dev = direct ? declaredDirect.every((n) => directDevNames.has(n)) : null;

    if (isBerry) {
      if (!resolution) return;
      const r = splitDescriptor(resolution);
      const target = berryTarget(r.name, r.range, version);
      if (target.kind === 'entry') {
        const entry = { name: target.name, version: target.version, direct, dev };
        if (target.resolved) out.addResolved(entry, target.resolved);
        else out.add(entry);
      } else if (target.kind === 'skip') {
        out.skip(r.name, r.range, target.reason);
      }
      return;
    }

    const first = targets[0]!;
    const kind = classifySpec(first.range);
    if (kind === null && version && /^\d/.test(version)) {
      out.addResolved({ name: first.name, version, direct, dev }, resolved ?? undefined);
      return;
    }
    if (kind === 'tarball' && version) {
      const url = resolved ?? first.range;
      if (checkResolvedShape(first.name, version, url).kind === 'ok') {
        out.addResolved({ name: first.name, version, direct, dev }, url);
        return;
      }
    }
    out.skip(first.name, resolved ?? (first.range || (version ?? '')), kind ?? 'other');
  };

  for (const line of lines) {
    if (line.length === 0 || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      flush();
      descriptors = [];
      version = null;
      resolved = null;
      resolution = null;
      if (!line.trimEnd().endsWith(':')) continue;
      const header = line.trimEnd().slice(0, -1);
      if (header === '__metadata') continue;
      descriptors = header.split(',').map((d) => d.trim()).filter(Boolean);
      continue;
    }
    // Classic: `  version "1.2.3"`. Berry: `  version: 1.2.3`.
    const field = line.trimEnd().match(FIELD);
    if (!field) continue;
    const value = unquote(field[2]!);
    if (field[1] === 'version') version = value;
    else if (field[1] === 'resolved') resolved = value;
    else resolution = value;
  }
  flush();

  return {
    manager: 'yarn',
    path,
    format: isBerry ? 'yarn.lock (Berry)' : 'yarn.lock (classic v1)',
    mtime,
    entries: out.entries,
    skipped: out.skipped,
  };
}
