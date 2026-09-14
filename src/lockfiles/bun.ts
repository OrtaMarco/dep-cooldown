import type { LockEntry, ParsedLockfile } from '../types.js';

/**
 * `bun.lock` is JSONC: it carries trailing commas, and Bun reserves the right
 * to write comments. `JSON.parse` refuses both, so strip them first. The
 * scanner is string- and escape-aware so that a `//` inside a version range or
 * an integrity hash survives, and it drops trailing commas itself, so a `, }`
 * inside a string is left alone.
 */
export function stripJsonc(input: string): string {
  // Chunks rather than one string, so dropping a comma is O(1) on big lockfiles.
  const out: string[] = [];
  let inString = false;
  let inLine = false;
  let inBlock = false;
  // Index in `out` of a comma followed so far only by blanks and comments.
  let pendingComma = -1;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const next = input[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out.push(c);
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out.push(c);
      if (c === '\\') {
        // Copy the escaped character verbatim so `\"` does not close the string.
        if (next !== undefined) {
          out.push(next);
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      out.push(c);
      continue;
    }
    // The first significant character after a comma settles it.
    if (pendingComma !== -1) {
      if (c === '}' || c === ']') out[pendingComma] = '';
      pendingComma = -1;
    }
    if (c === '"') inString = true;
    if (c === ',') pendingComma = out.length;
    out.push(c);
  }

  return out.join('');
}

interface BunLock {
  lockfileVersion?: number;
  workspaces?: Record<
    string,
    {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
  packages?: Record<string, unknown[]>;
}

/** `@scope/name@1.2.3` -> `{name, version}`; anything non-registry -> null. */
function splitLocator(locator: string): { name: string; version: string } | null {
  const at = locator.lastIndexOf('@');
  if (at <= 0) return null;
  const name = locator.slice(0, at);
  const version = locator.slice(at + 1);
  // `workspace:`, `git+…`, `file:…`, `link:…` have no registry publish date.
  if (!/^\d/.test(version)) return null;
  return { name, version };
}

/** Parses Bun's text lockfile (`bun.lock`, lockfileVersion 0 and 1). */
export function parseBunLock(raw: string, path: string, mtime: string): ParsedLockfile {
  const lock = JSON.parse(stripJsonc(raw)) as BunLock;

  const direct = new Set<string>();
  const directDev = new Set<string>();
  for (const ws of Object.values(lock.workspaces ?? {})) {
    for (const n of Object.keys(ws.dependencies ?? {})) direct.add(n);
    for (const n of Object.keys(ws.optionalDependencies ?? {})) direct.add(n);
    for (const n of Object.keys(ws.peerDependencies ?? {})) direct.add(n);
    for (const n of Object.keys(ws.devDependencies ?? {})) {
      direct.add(n);
      directDev.add(n);
    }
  }

  const entries: LockEntry[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(lock.packages ?? {})) {
    const locator = Array.isArray(value) ? value[0] : undefined;
    if (typeof locator !== 'string') continue;
    const parsed = splitLocator(locator);
    if (!parsed) continue;
    const id = `${parsed.name}@${parsed.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const isDirect = direct.has(parsed.name);
    entries.push({
      name: parsed.name,
      version: parsed.version,
      direct: isDirect,
      dev: isDirect ? directDev.has(parsed.name) : null,
    });
  }

  return {
    manager: 'bun',
    path,
    format: `bun.lock v${lock.lockfileVersion ?? '?'}`,
    mtime,
    entries,
  };
}
