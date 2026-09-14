import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRegistry, registryFor, readExistingNpmCooldown } from '../dist/index.js';
import { fixture } from './helpers.js';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

/** Runs the built CLI and returns `{code, stdout, stderr}` without throwing. */
async function cli(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('cli', () => {
  test('--help exits 0 and documents the exit code', async () => {
    const { code, stdout } = await cli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--min-age <days>/);
    assert.match(stdout, /Exits 1 when any package is flagged/);
  });

  test('--version prints a semver', async () => {
    const { code, stdout } = await cli(['--version']);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  test('--config all works offline and exits 0', async () => {
    const { code, stdout } = await cli(['--config', 'all', '--min-age', '5']);
    assert.equal(code, 0);
    assert.match(stdout, /min-release-age=5/);
    assert.match(stdout, /minimumReleaseAge: 7200/); // pnpm, minutes
    assert.match(stdout, /minimumReleaseAge = 432000/); // bun, seconds
  });

  test('an unknown --config target exits 2', async () => {
    const { code, stderr } = await cli(['--config', 'deno']);
    assert.equal(code, 2);
    assert.match(stderr, /expects one of npm, pnpm, yarn, bun, all/);
  });

  test('an unknown flag exits 2 rather than being ignored', async () => {
    const { code, stderr } = await cli(['--nope']);
    assert.equal(code, 2);
    assert.match(stderr, /Run --help for usage/);
  });

  test('--min-age rejects a non-number', async () => {
    const { code, stderr } = await cli(['--min-age', 'soon', '--config', 'npm']);
    assert.equal(code, 2);
    assert.match(stderr, /--min-age expects a non-negative number/);
  });

  test('--as-of rejects an unparseable date', async () => {
    const { code, stderr } = await cli(['--as-of', 'yesterday', '--cwd', fixture('npm-v3')]);
    assert.equal(code, 2);
    assert.match(stderr, /--as-of expects an ISO date/);
  });

  test('a directory with no lockfile exits 2 with a usable message', async () => {
    const { code, stderr } = await cli(['--cwd', fixture('empty')]);
    assert.equal(code, 2);
    assert.match(stderr, /No lockfile found/);
    assert.match(stderr, /package-lock\.json/);
  });

  test('--offline with an empty cache still renders, and says what is missing', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const { code, stdout, stderr } = await cli(
      ['--cwd', fixture('npm-v3'), '--offline', '--json'],
      { DEP_COOLDOWN_CACHE_DIR: cacheDir },
    );
    // Nothing checked is not a pass: exit 3, not 0 (see cli-hardening.test.js).
    assert.equal(code, 3, 'nothing is young, but nothing could be checked either');
    const result = JSON.parse(stdout);
    assert.equal(result.offline, true);
    assert.equal(result.totals.packages, 14);
    assert.equal(result.totals.unknown, 14);
    assert.ok(result.rows.every((r) => r.error === 'not in cache (--offline)'));
    // JSON goes to stdout untouched; stderr carries only the one-line reason for exit 3.
    assert.equal(stderr.trimEnd().split('\n').length, 1);
    assert.match(stderr, /exit 3 .*--allow-unknown/);
  });

  test('--offline in table mode warns on stderr', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const { stdout, stderr } = await cli(['--cwd', fixture('npm-v3'), '--offline'], {
      DEP_COOLDOWN_CACHE_DIR: cacheDir,
    });
    assert.match(stdout, /offline/);
    assert.match(stderr, /not in the cache; run once without --offline/);
  });

  test('--json is valid JSON carrying the whole run context', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const { stdout } = await cli(
      ['--cwd', fixture('pnpm-v9'), '--offline', '--json', '--min-age', '3'],
      { DEP_COOLDOWN_CACHE_DIR: cacheDir },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.manager, 'pnpm');
    assert.equal(result.format, 'pnpm-lock.yaml v9');
    assert.equal(result.minAgeDays, 3);
    assert.match(result.lockfileModified, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.asOfExplicit, false);
    assert.ok(Array.isArray(result.rows));
  });

  test('--only-direct narrows the row set', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    const { stdout } = await cli(
      ['--cwd', fixture('yarn-berry'), '--offline', '--json', '--only-direct'],
      { DEP_COOLDOWN_CACHE_DIR: cacheDir },
    );
    assert.equal(JSON.parse(stdout).totals.packages, 3);
  });

  test('--clear-cache removes the directory it names', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dep-cooldown-cache-'));
    await writeFile(join(cacheDir, 'x.json'), '{}');
    const { code, stdout } = await cli(['--clear-cache'], { DEP_COOLDOWN_CACHE_DIR: cacheDir });
    assert.equal(code, 0);
    assert.ok(stdout.includes(cacheDir));
  });
});

describe('.npmrc handling', () => {
  test('a project registry= overrides the default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-npmrc-'));
    await writeFile(join(dir, '.npmrc'), 'registry=https://npm.example.test/\n');
    const config = resolveRegistry(dir);
    assert.equal(config.default, 'https://npm.example.test');
    assert.equal(config.source, '.npmrc (project)');
  });

  test('--registry beats the .npmrc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-npmrc-'));
    await writeFile(join(dir, '.npmrc'), 'registry=https://npm.example.test\n');
    const config = resolveRegistry(dir, 'https://other.test');
    assert.equal(config.default, 'https://other.test');
    assert.equal(config.source, '--registry');
  });

  test('scoped registries route only their own scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-npmrc-'));
    await writeFile(
      join(dir, '.npmrc'),
      ['registry=https://npm.example.test', '@acme:registry=https://acme.test/npm/'].join('\n'),
    );
    const config = resolveRegistry(dir);
    assert.equal(registryFor('@acme/thing', config), 'https://acme.test/npm');
    assert.equal(registryFor('@other/thing', config), 'https://npm.example.test');
    assert.equal(registryFor('ms', config), 'https://npm.example.test');
  });

  test('comments, quotes and ${ENV} interpolation are handled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-npmrc-'));
    process.env.DEP_COOLDOWN_TEST_HOST = 'interpolated.test';
    await writeFile(
      join(dir, '.npmrc'),
      [
        '; a comment',
        '# another comment',
        'registry="https://${DEP_COOLDOWN_TEST_HOST}/"',
        'min-release-age=14',
      ].join('\n'),
    );
    assert.equal(resolveRegistry(dir).default, 'https://interpolated.test');
    assert.equal(readExistingNpmCooldown(dir).minAge, 14);
    delete process.env.DEP_COOLDOWN_TEST_HOST;
  });

  test('a missing .npmrc falls back to the public registry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-npmrc-'));
    await mkdir(join(dir, 'sub'), { recursive: true });
    const config = resolveRegistry(join(dir, 'sub'));
    assert.ok(config.default.startsWith('https://'));
  });
});
