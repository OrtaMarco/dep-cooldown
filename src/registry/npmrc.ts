import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * npm's own `${VAR}` expansion, copied from @npmcli/config (lib/env-replace.js):
 * `${VAR}` becomes the variable, `${VAR?}` becomes '' when it is unset, an unset
 * `${VAR}` without `?` stays literal, and backslashes escape the `$`.
 *
 * The name class `[^${}?]` cannot cross another `$`, `{` or `}`, so every scan
 * stops at the next candidate and the whole replace is linear. The previous
 * `\$\{([^}]+)\}` ran on to the end of the line from every `${`, which is
 * quadratic: 160 KB of `${` took about 8 seconds.
 */
const ENV_EXPR = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g;

function envReplace(field: string): string {
  return field.replace(ENV_EXPR, (orig: string, esc: string, name: string, modifier?: string) => {
    const fallback = modifier === '?' ? '' : `\${${name}}`;
    const val = process.env[name] ?? fallback;
    if (esc.length % 2) return orig.slice((esc.length + 1) / 2);
    return esc.slice(esc.length / 2) + val;
  });
}

/** One config value: what npm will use, and the text as it was written. */
interface IniValue {
  value: string;
  raw: string;
}

function parseIni(text: string): Map<string, IniValue> {
  const out = new Map<string, IniValue>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    // npm expands keys too, e.g. `//${HOST}/:_authToken`.
    const key = envReplace(trimmed.slice(0, eq).trim());
    let raw = trimmed.slice(eq + 1).trim();
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      raw = raw.slice(1, -1);
    }
    out.set(key, { value: envReplace(raw), raw });
  }
  return out;
}

function readIni(path: string): Map<string, IniValue> {
  try {
    return parseIni(readFileSync(path, 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * `npm_config_*` variables the way @npmcli/config `loadEnv()` reads them: the
 * prefix is case-insensitive, empty values are ignored, the key is lowercased
 * with every `_` after its first character turned into `-`, and values go
 * through the same `${VAR}` expansion as the files. When two spellings of the
 * same key are set, the later one in `process.env` wins, as in npm.
 */
function readEnvConfig(): Map<string, IniValue> {
  const out = new Map<string, IniValue>();
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envVal === undefined || envVal === '' || !/^npm_config_/i.test(envKey)) continue;
    let key = envKey.slice('npm_config_'.length);
    if (!key.startsWith('//')) key = key.replace(/(?!^)_/g, '-').toLowerCase();
    out.set(key, { value: envReplace(envVal), raw: envVal });
  }
  return out;
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
 * Registry URLs that `resolveRegistry` built by expanding `${VAR}`, mapped to
 * the text as it was written. `redactRegistryUrl` shows the written form, so an
 * expanded token never reaches a report header, `--json` or an error message.
 */
const expandedTemplates = new Map<string, string>();

function remember(entry: IniValue): string {
  const value = normalize(entry.value);
  if (entry.value !== entry.raw) expandedTemplates.set(value, normalize(entry.raw));
  return value;
}

/** Replaces the userinfo of `scheme://user:pass@host/…` with `***`. */
function hideUserinfo(url: string): string {
  const schemeEnd = url.indexOf('://');
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  let authorityEnd = url.length;
  // `\` ends the authority too: WHATWG URLs read it as `/` for http(s).
  for (const stop of ['/', '?', '#', '\\']) {
    const at = url.indexOf(stop, authorityStart);
    if (at !== -1 && at < authorityEnd) authorityEnd = at;
  }
  const authority = url.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  return `${url.slice(0, authorityStart)}***@${authority.slice(at + 1)}${url.slice(authorityEnd)}`;
}

/**
 * The form of a registry URL that is safe to print. Userinfo becomes `***`,
 * and a URL that `resolveRegistry` built by expanding `${VAR}` is shown as it
 * was written (`https://host/${TOKEN}`), never with the expanded value; this
 * also covers a request URL under such a registry. A URL that did not come
 * from `resolveRegistry` in this process only gets its userinfo hidden.
 */
export function redactRegistryUrl(url: string): string {
  let shown = expandedTemplates.get(url) ?? expandedTemplates.get(normalize(url));
  if (shown === undefined) {
    for (const [expanded, template] of expandedTemplates) {
      if (url.startsWith(`${expanded}/`)) {
        shown = template + url.slice(expanded.length);
        break;
      }
    }
  }
  return hideUserinfo(shown ?? url);
}

function userConfigPath(env: Map<string, IniValue>): { path: string; fromEnv: boolean } {
  const fallback = join(homedir(), '.npmrc');
  const configured = env.get('userconfig')?.value;
  if (!configured) return { path: fallback, fromEnv: false };
  // npm's `path` type expands a leading `~`.
  const expanded = /^~(?=$|[/\\])/.test(configured) ? homedir() + configured.slice(1) : configured;
  const path = resolve(expanded);
  // `npm run` exports npm_config_userconfig even when it is just ~/.npmrc.
  return { path, fromEnv: path !== fallback };
}

/**
 * Resolves the registry the way npm does. Precedence, highest first — see
 * https://docs.npmjs.com/cli/v11/using-npm/config#environment-variables and
 * https://docs.npmjs.com/cli/v11/configuring-npm/npmrc#files, and the load
 * order in @npmcli/config `load()`: cli, env, project, user, global:
 *
 *   1. an explicit `--registry` (npm's command line);
 *   2. `npm_config_registry`, prefix matched case-insensitively, empty ignored;
 *   3. the project `.npmrc` in `cwd`;
 *   4. the user config: `npm_config_userconfig` when set (where
 *      `actions/setup-node` with `registry-url` writes it), else `~/.npmrc`;
 *   5. the public registry.
 *
 * `@scope:registry` follows the same order, `npm_config_@scope:registry`
 * included. Not read: the global `$PREFIX/etc/npmrc`, npm's builtin npmrc, a
 * `userconfig=` set inside the project `.npmrc`, and npm's walk up to the
 * nearest `package.json` for the project file (here `cwd` is the project).
 * Like npm, a project `.npmrc` that is the user config file is read once.
 */
export function resolveRegistry(cwd: string, override?: string): RegistryConfig {
  const env = readEnvConfig();
  const userconfig = userConfigPath(env);
  const projectPath = resolve(cwd, '.npmrc');
  const project =
    projectPath === userconfig.path ? new Map<string, IniValue>() : readIni(projectPath);
  const user = readIni(userconfig.path);

  const scoped = new Map<string, string>();
  for (const ini of [user, project, env]) {
    for (const [key, entry] of ini) {
      if (key.startsWith('@') && key.endsWith(':registry') && entry.value) {
        scoped.set(key.slice(0, -':registry'.length), remember(entry));
      }
    }
  }

  if (override) return { default: normalize(override), scoped, source: '--registry' };

  const fromEnv = env.get('registry');
  if (fromEnv?.value) return { default: remember(fromEnv), scoped, source: 'npm_config_registry' };

  const fromProject = project.get('registry');
  if (fromProject?.value) {
    return { default: remember(fromProject), scoped, source: '.npmrc (project)' };
  }

  const fromUser = user.get('registry');
  if (fromUser?.value) {
    const source = userconfig.fromEnv ? 'npm_config_userconfig' : '~/.npmrc';
    return { default: remember(fromUser), scoped, source };
  }

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
  const raw = ini.get('min-release-age')?.value;
  const exclude: string[] = [];
  const one = ini.get('min-release-age-exclude')?.value;
  if (one) exclude.push(one);
  const minAge = raw !== undefined && raw !== '' ? Number(raw) : undefined;
  return Number.isFinite(minAge) ? { minAge, exclude } : { exclude };
}
