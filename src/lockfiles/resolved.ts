import type { LockEntry, SkippedEntry } from '../types.js';

export type SkipReason = SkippedEntry['reason'];

/**
 * `registry.yarnpkg.com` is a CNAME for `registry.npmjs.org`: same packuments,
 * same tarballs. Yarn classic writes the former, npm the latter.
 */
const PUBLIC_REGISTRY_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);

function canonicalHost(host: string): string {
  const h = host.toLowerCase();
  return PUBLIC_REGISTRY_HOSTS.has(h) ? 'registry.npmjs.org' : h;
}

/** `@scope/name` -> `name`. */
function unscoped(name: string): string {
  const slash = name.indexOf('/');
  return name.startsWith('@') && slash !== -1 ? name.slice(slash + 1) : name;
}

/**
 * A name that could exist in a registry. Deliberately permissive (legacy names
 * carry capitals), it only rejects what no registry accepts and what would
 * change the request or the cache path: empty segments, `.`/`..`, a leading
 * dot or underscore, whitespace, and `?#%\:` or a stray `@`.
 */
export function isRegistryName(name: string): boolean {
  const m = name.match(/^(?:@([^/]+)\/)?([^/]+)$/);
  if (!m) return false;
  return [m[1], m[2]].every(
    (segment) =>
      segment === undefined ||
      (segment.length > 0 && !/^[._]/.test(segment) && !/[\s?#%\\:@]/.test(segment)),
  );
}

const GIT_PREFIX = /^(?:git\+|git:|git@|ssh:|github:|gitlab:|bitbucket:|gist:)/i;

/**
 * Classifies a locator or range that is not a registry version: what the
 * lockfile wrote after `name@`, or a `resolved` URL. `null` means it looks
 * like a registry range (`^1.2.3`, `1.2.3`, `latest`).
 */
export function classifySpec(spec: string): SkipReason | null {
  const s = spec.trim();
  if (GIT_PREFIX.test(s)) return 'git';
  if (s.startsWith('file:')) return 'file';
  if (s.startsWith('link:') || s.startsWith('portal:')) return 'link';
  if (s.startsWith('workspace:')) return 'workspace';
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return 'other';
    }
    if (url.hostname.toLowerCase() === 'codeload.github.com') return 'git';
    if (/\.git$/i.test(url.pathname) || url.hash.startsWith('#commit=')) return 'git';
    return 'tarball';
  }
  // `user/repo` and `user/repo#ref`: the GitHub shorthand npm and Yarn accept.
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(s) && !s.startsWith('@')) return 'git';
  if (s.startsWith('.') || s.startsWith('/') || s.startsWith('~')) return 'file';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return 'other';
  return null;
}

/** Decodes a tarball pathname, tolerating `@scope%2fname` and bad escapes. */
function decodePath(pathname: string): string {
  const slashes = pathname.replace(/%2f/gi, '/');
  try {
    return decodeURIComponent(slashes);
  } catch {
    return slashes;
  }
}

export type ShapeCheck =
  | { kind: 'ok'; version: string }
  | { kind: 'mismatch'; reason: string }
  | { kind: 'skip'; reason: SkipReason };

/**
 * The host-independent half of {@link verifyResolved}: does this URL name the
 * registry tarball for `name@version`?
 *
 * Registry tarballs live at `…/<name>/-/<basename>-<version>.tgz`, basename
 * being the unscoped name (npm, Yarn, Verdaccio, Artifactory, Nexus) or the
 * scoped one (GitLab). GitHub Packages serves `…/download/<name>/<version>/<id>`.
 * Queries and fragments are ignored.
 *
 * - `ok`: it is that tarball. With `version === null` (Bun writes tarball
 *   dependencies without one) the version is read from the file name.
 * - `mismatch`: a registry tarball, but for another name or version.
 * - `skip`: not a registry tarball at all (git, a local path, any other URL).
 */
export function checkResolvedShape(
  name: string,
  version: string | null,
  resolved: string,
): ShapeCheck {
  if (!/^https?:\/\//i.test(resolved.trim())) {
    return { kind: 'skip', reason: classifySpec(resolved) ?? 'other' };
  }
  let url: URL;
  try {
    url = new URL(resolved.trim());
  } catch {
    return { kind: 'skip', reason: 'other' };
  }
  const path = decodePath(url.pathname);

  const tgz = path.match(/^(.*)\/-\/((?:@[^/]+\/)?[^/]+)\.tgz$/i);
  if (tgz) {
    const dir = tgz[1]!;
    const file = tgz[2]!;
    const bases = [unscoped(name), name];
    const base = bases.find((b) => file.startsWith(`${b}-`));
    const fileVersion = base === undefined ? null : file.slice(base.length + 1);
    if (!dir.endsWith(`/${name}`) || fileVersion === null) {
      return {
        kind: 'mismatch',
        reason: `resolved tarball ${path.slice(path.lastIndexOf('/-/') + 3)} under ${dir || '/'} is not a ${name} tarball`,
      };
    }
    if (version === null) {
      return /^\d/.test(fileVersion)
        ? { kind: 'ok', version: fileVersion }
        : { kind: 'skip', reason: 'tarball' };
    }
    if (fileVersion !== version) {
      return {
        kind: 'mismatch',
        reason: `lockfile says ${name}@${version} but resolved points at the ${fileVersion} tarball`,
      };
    }
    return { kind: 'ok', version };
  }

  const gh = path.match(/\/download\/((?:@[^/]+\/)?[^/]+)\/([^/]+)\/[^/]+$/);
  if (gh) {
    if (gh[1] !== name || (version !== null && gh[2] !== version)) {
      return {
        kind: 'mismatch',
        reason: `lockfile says ${name}@${version ?? '?'} but resolved downloads ${gh[1]}@${gh[2]}`,
      };
    }
    if (!/^\d/.test(gh[2]!)) return { kind: 'skip', reason: 'tarball' };
    return { kind: 'ok', version: gh[2]! };
  }

  return { kind: 'skip', reason: classifySpec(resolved) ?? 'tarball' };
}

/**
 * Checks that `resolved` is the tarball the registry dates for `name@version`,
 * so that the publish date the audit reports describes what gets installed.
 * Returns why not, or `undefined` when it matches.
 *
 * The host must be the registry's, with two allowances:
 * - `registry.npmjs.org` and `registry.yarnpkg.com` are the same registry;
 * - a tarball on the public registry is accepted whatever `registryUrl` is,
 *   because npm rewrites that host to the configured registry at install time
 *   (`replace-registry-host`, default `npmjs`): the package comes from the
 *   registry the audit asks. The name and version are still checked.
 */
export function verifyResolved(
  name: string,
  version: string,
  resolved: string,
  registryUrl: string,
): string | undefined {
  const shape = checkResolvedShape(name, version, resolved);
  if (shape.kind === 'mismatch') return shape.reason;
  if (shape.kind === 'skip') return `resolved ${resolved} is not a registry tarball (${shape.reason})`;

  let tarballHost: string;
  let registryHost: string;
  try {
    tarballHost = canonicalHost(new URL(resolved.trim()).host);
  } catch {
    return `resolved ${resolved} is not a URL`;
  }
  try {
    registryHost = canonicalHost(new URL(registryUrl).host);
  } catch {
    return `registry ${registryUrl} is not a URL`;
  }
  if (tarballHost === registryHost) return undefined;
  if (tarballHost === 'registry.npmjs.org') return undefined;
  return `resolved from ${tarballHost}, but ${name} is looked up in ${registryHost}`;
}

/**
 * Accumulates what a parser finds. Entries are unique by `name@version`; when
 * the same pair shows up twice (npm nests copies), a problem found on any copy
 * sticks, so a clean first copy cannot hide a tampered second one.
 */
export class LockCollector {
  readonly entries: LockEntry[] = [];
  readonly skipped: SkippedEntry[] = [];
  private readonly byId = new Map<string, LockEntry>();
  private readonly skippedIds = new Set<string>();

  add(entry: LockEntry): void {
    if (!isRegistryName(entry.name)) {
      this.skip(entry.name, `${entry.name}@${entry.version}`, 'other');
      return;
    }
    const id = `${entry.name}@${entry.version}`;
    const prior = this.byId.get(id);
    if (!prior) {
      this.byId.set(id, entry);
      this.entries.push(entry);
      return;
    }
    prior.direct ||= entry.direct;
    if (prior.dev !== entry.dev) {
      // One copy needed in production is enough to keep it in `--prod`.
      prior.dev = prior.dev === false || entry.dev === false ? false : null;
    }
    if (!prior.unverifiable && entry.unverifiable) prior.unverifiable = entry.unverifiable;
    if (entry.resolved) {
      if (!prior.resolved) {
        prior.resolved = entry.resolved;
      } else if (!prior.unverifiable && hostOf(prior.resolved) !== hostOf(entry.resolved)) {
        prior.unverifiable = `${id} resolves to two hosts: ${hostOf(prior.resolved)} and ${hostOf(entry.resolved)}`;
      }
    }
  }

  /**
   * Adds a registry entry after checking its `resolved`, when there is one:
   * a mismatch marks it unverifiable, a non-registry URL skips it.
   */
  addResolved(entry: LockEntry, resolved: string | undefined): void {
    if (!resolved) {
      this.add(entry);
      return;
    }
    const shape = checkResolvedShape(entry.name, entry.version, resolved);
    if (shape.kind === 'skip') {
      this.skip(entry.name, resolved, shape.reason);
      return;
    }
    const withResolved: LockEntry = { ...entry, resolved };
    if (shape.kind === 'mismatch') withResolved.unverifiable = shape.reason;
    this.add(withResolved);
  }

  skip(name: string, spec: string, reason: SkipReason): void {
    const id = `${reason}\u0000${name}\u0000${spec}`;
    if (this.skippedIds.has(id)) return;
    this.skippedIds.add(id);
    this.skipped.push({ name, spec, reason });
  }
}

function hostOf(url: string): string {
  try {
    return canonicalHost(new URL(url.trim()).host);
  } catch {
    return url;
  }
}
