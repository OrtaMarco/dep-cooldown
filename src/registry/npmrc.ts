import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

function parseIni(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // `${NPM_TOKEN}` style interpolation, the way npm does it.
    value = value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => process.env[name] ?? '');
    out.set(key, value);
  }
  return out;
}

function readIni(path: string): Map<string, string> {
  try {
    return parseIni(readFileSync(path, 'utf8'));
  } catch {
    return new Map();
  }
}

export interface RegistryConfig {
  /** Registry used for unscoped packages. */
  default: string;
  /** `@scope` -> registry URL, from `@scope:registry=` lines. */
  scoped: Map<string, string>;
  /** Where the default came from, for the report header. */
  source: string;
}

function normalize(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Resolves the registry the way npm does, in decreasing precedence:
 * an explicit `--registry`, `npm_config_registry` / `NPM_CONFIG_REGISTRY`,
 * the project `.npmrc`, the user `~/.npmrc`, then the public registry.
 * Scoped registries (`@scope:registry=`) are honoured too.
 */
export function resolveRegistry(cwd: string, override?: string): RegistryConfig {
  const scoped = new Map<string, string>();
  const project = readIni(join(cwd, '.npmrc'));
  const user = readIni(join(homedir(), '.npmrc'));

  for (const ini of [user, project]) {
    for (const [key, value] of ini) {
      if (key.startsWith('@') && key.endsWith(':registry')) {
        scoped.set(key.slice(0, -':registry'.length), normalize(value));
      }
    }
  }

  if (override) return { default: normalize(override), scoped, source: '--registry' };

  const env = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  if (env) return { default: normalize(env), scoped, source: 'npm_config_registry' };

  const fromProject = project.get('registry');
  if (fromProject) return { default: normalize(fromProject), scoped, source: '.npmrc (project)' };

  const fromUser = user.get('registry');
  if (fromUser) return { default: normalize(fromUser), scoped, source: '~/.npmrc' };

  return { default: DEFAULT_REGISTRY, scoped, source: 'default' };
}

/** Picks the registry for one package name, honouring scoped overrides. */
export function registryFor(name: string, config: RegistryConfig): string {
  if (name.startsWith('@')) {
    const scope = name.slice(0, name.indexOf('/'));
    const hit = config.scoped.get(scope);
    if (hit) return hit;
  }
  return config.default;
}

/** Reads `min-release-age` / `min-release-age-exclude` already set in `.npmrc`. */
export function readExistingNpmCooldown(cwd: string): { minAge?: number; exclude: string[] } {
  const ini = readIni(join(cwd, '.npmrc'));
  const raw = ini.get('min-release-age');
  const exclude: string[] = [];
  const one = ini.get('min-release-age-exclude');
  if (one) exclude.push(one);
  const minAge = raw !== undefined && raw !== '' ? Number(raw) : undefined;
  return Number.isFinite(minAge) ? { minAge, exclude } : { exclude };
}
