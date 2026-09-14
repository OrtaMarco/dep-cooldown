import type { ParsedLockfile } from '../types.js';
import { LockCollector, checkResolvedShape, classifySpec } from './resolved.js';

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

/**
 * `@scope/name@locator` -> `{name, locator}`, split at the first `@` after a
 * possible scope because git locators carry `@` too.
 */
function splitLocator(locator: string): { name: string; spec: string } | null {
  const at = locator.indexOf('@', 1);
  return at > 0 ? { name: locator.slice(0, at), spec: locator.slice(at + 1) } : null;
}

/** A top-level `packages` key is the name its dependents declare (an alias or not). */
const TOP_LEVEL_KEY = /^(?:@[^/]+\/)?[^/]+$/;

/** Parses Bun's text lockfile (`bun.lock`, lockfileVersion 0 and 1). */
export function parseBunLock(raw: string, path: string, mtime: string): ParsedLockfile {
  const lock = JSON.parse(stripJsonc(raw)) as BunLock;

  const direct = new Set<string>();
  const prodNames = new Set<string>();
  const devNames = new Set<string>();
  for (const ws of Object.values(lock.workspaces ?? {})) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const) {
      for (const n of Object.keys(ws[field] ?? {})) {
        direct.add(n);
        (field === 'devDependencies' ? devNames : prodNames).add(n);
      }
    }
  }

  const out = new LockCollector();
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    const locator = Array.isArray(value) ? value[0] : undefined;
    if (typeof locator !== 'string') continue;
    const split = splitLocator(locator);
    if (!split) {
      out.skip(key, locator, 'other');
      continue;
    }
    const { name, spec } = split;

    let version: string | null = null;
    let resolved: string | undefined;
    if (/^\d/.test(spec)) {
      version = spec;
    } else if (/^https?:\/\//i.test(spec)) {
      // A tarball dependency: audited when the URL is the registry tarball.
      const shape = checkResolvedShape(name, null, spec);
      if (shape.kind === 'ok') {
        version = shape.version;
        resolved = spec;
      } else {
        out.skip(name, spec, shape.kind === 'skip' ? shape.reason : 'tarball');
        continue;
      }
    } else {
      // `workspace:`, `github:`, `git+…`, `file:…`, `link:…`: no publish date.
      if (spec !== 'workspace:' && spec !== 'workspace:.') {
        out.skip(name, spec, classifySpec(spec) ?? 'other');
      }
      continue;
    }

    const declared = [name, ...(TOP_LEVEL_KEY.test(key) && key !== name ? [key] : [])].filter((n) =>
      direct.has(n),
    );
    const isDirect = declared.length > 0;
    out.addResolved(
      {
        name,
        version,
        direct: isDirect,
        // Dev only when no workspace declares it outside devDependencies.
        dev: isDirect ? declared.every((n) => devNames.has(n) && !prodNames.has(n)) : null,
      },
      resolved,
    );
  }

  return {
    manager: 'bun',
    path,
    format: `bun.lock v${lock.lockfileVersion ?? '?'}`,
    mtime,
    entries: out.entries,
    skipped: out.skipped,
  };
}
