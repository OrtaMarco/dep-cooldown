import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAndParse, parsePnpmKey, stripJsonc, NoLockfileError } from '../dist/index.js';
import { fixture } from './helpers.js';

/**
 * All six fixtures were produced from the same `package.json`, so every parser
 * must agree on the same 14 package@version pairs. That is the whole point:
 * a format-specific bug shows up as a diff against its siblings.
 */
const EXPECTED = [
  '@babel/code-frame@7.24.7',
  '@babel/helper-validator-identifier@7.29.7',
  '@babel/highlight@7.25.9',
  'ansi-styles@3.2.1',
  'chalk@2.4.2',
  'color-convert@1.9.3',
  'color-name@1.1.3',
  'escape-string-regexp@1.0.5',
  'has-flag@3.0.0',
  'is-number@7.0.0',
  'js-tokens@4.0.0',
  'ms@2.1.3',
  'picocolors@1.1.1',
  'supports-color@5.5.0',
];

const DIRECT = ['@babel/code-frame', 'is-number', 'ms'];

const CASES = [
  ['npm-v3', 'package-lock.json v3', 'npm'],
  ['npm-v2', 'package-lock.json v2', 'npm'],
  ['pnpm-v9', 'pnpm-lock.yaml v9', 'pnpm'],
  ['pnpm-v6', 'pnpm-lock.yaml v6', 'pnpm'],
  ['yarn-classic', 'yarn.lock (classic v1)', 'yarn'],
  ['yarn-berry', 'yarn.lock (Berry)', 'yarn'],
  ['bun', 'bun.lock v1', 'bun'],
];

describe('lockfile parsers', () => {
  for (const [dir, format, manager] of CASES) {
    test(`${dir} resolves the same 14 packages`, async () => {
      const lock = await detectAndParse(fixture(dir));
      assert.equal(lock.manager, manager);
      assert.equal(lock.format, format);
      const ids = lock.entries.map((e) => `${e.name}@${e.version}`).sort();
      assert.deepEqual(ids, [...EXPECTED].sort());
    });

    test(`${dir} marks the three direct dependencies`, async () => {
      const lock = await detectAndParse(fixture(dir));
      const direct = lock.entries
        .filter((e) => e.direct)
        .map((e) => e.name)
        .sort();
      assert.deepEqual(direct, DIRECT);
    });

    test(`${dir} records a lockfile mtime`, async () => {
      const lock = await detectAndParse(fixture(dir));
      assert.match(lock.mtime, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(lock.path.endsWith(format.split(' ')[0]));
    });
  }

  test('npm and pnpm know is-number is a dev dependency', async () => {
    for (const dir of ['npm-v3', 'npm-v2', 'pnpm-v6', 'pnpm-v9', 'bun']) {
      const lock = await detectAndParse(fixture(dir));
      const row = lock.entries.find((e) => e.name === 'is-number');
      assert.equal(row.dev, true, `${dir} should mark is-number dev`);
      assert.equal(
        lock.entries.find((e) => e.name === 'ms').dev,
        false,
        `${dir} should mark ms non-dev`,
      );
    }
  });

  test('yarn cannot tell whether a transitive package is dev-only', async () => {
    const lock = await detectAndParse(fixture('yarn-berry'));
    assert.equal(lock.entries.find((e) => e.name === 'is-number').dev, true);
    // `chalk` is transitive; neither Yarn format records a dev flag for it.
    assert.equal(lock.entries.find((e) => e.name === 'chalk').dev, null);
  });

  test('an explicit --lockfile wins over detection order', async () => {
    const lock = await detectAndParse(fixture('npm-v3'), 'package-lock.json');
    assert.equal(lock.manager, 'npm');
  });

  test('a directory with no lockfile throws NoLockfileError', async () => {
    await assert.rejects(() => detectAndParse(fixture('empty')), NoLockfileError);
  });
});

/**
 * pnpm 11+ writes the environment lockfile (here the pnpm binary that
 * `devEngines.packageManager` pins) as a first YAML document before the
 * project's. The environment document in this fixture is verbatim from
 * unjs/h3 at a5fdc86; the project document is the pnpm-v9 fixture.
 */
describe('pnpm lockfile with an environment document', () => {
  const PNPM = [
    'pnpm@12.3.4',
    ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64'].map(
      (platform) => `@pnpm/exe.${platform}@12.3.4`,
    ),
  ];

  test('audits both documents instead of failing on the second', async () => {
    const lock = await detectAndParse(fixture('pnpm-v9-env'));
    assert.equal(lock.format, 'pnpm-lock.yaml v9');
    const ids = lock.entries.map((e) => `${e.name}@${e.version}`).sort();
    assert.deepEqual(ids, [...EXPECTED, ...PNPM].sort());
  });

  test('the pinned package manager counts as direct, not dev', async () => {
    const lock = await detectAndParse(fixture('pnpm-v9-env'));
    const pnpm = lock.entries.find((e) => e.name === 'pnpm');
    assert.equal(pnpm.direct, true);
    assert.equal(pnpm.dev, false);
    assert.deepEqual(
      lock.entries.filter((e) => e.direct).map((e) => e.name).sort(),
      [...DIRECT, 'pnpm'].sort(),
    );
  });

  test('a broken second document still throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-'));
    try {
      const raw = await readFile(fixture('pnpm-v9-env', 'pnpm-lock.yaml'), 'utf8');
      await writeFile(join(dir, 'pnpm-lock.yaml'), `${raw}\nimporters: [unclosed\n`);
      await assert.rejects(() => detectAndParse(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parsePnpmKey', () => {
  const cases = [
    ['ms@2.1.3', { name: 'ms', version: '2.1.3' }],
    ['/ms@2.1.3', { name: 'ms', version: '2.1.3' }],
    ['/ms/2.1.3', { name: 'ms', version: '2.1.3' }],
    ['@babel/code-frame@7.24.7', { name: '@babel/code-frame', version: '7.24.7' }],
    ['/@babel/code-frame@7.24.7', { name: '@babel/code-frame', version: '7.24.7' }],
    ['/@babel/code-frame/7.24.7', { name: '@babel/code-frame', version: '7.24.7' }],
    // v9 appends the peer set it was resolved against.
    ['@babel/core@7.25.0(supports-color@8.1.1)', { name: '@babel/core', version: '7.25.0' }],
    ['/vue@3.4.0(typescript@5.4.5)', { name: 'vue', version: '3.4.0' }],
  ];
  for (const [key, expected] of cases) {
    test(`parses ${key}`, () => {
      assert.deepEqual(parsePnpmKey(key), expected);
    });
  }

  test('rejects non-registry locators', () => {
    for (const key of [
      'foo@link:../bar',
      'foo@file:../bar.tgz',
      'foo@git+ssh://git@github.com/o/r.git',
      'my-app@workspace:packages/app',
    ]) {
      assert.equal(parsePnpmKey(key), null, key);
    }
  });
});

describe('stripJsonc', () => {
  test('removes line and block comments and trailing commas', () => {
    const input = `{
      // a line comment
      "a": 1, /* inline */
      "b": [2, 3,],
    }`;
    assert.deepEqual(JSON.parse(stripJsonc(input)), { a: 1, b: [2, 3] });
  });

  test('leaves comment-like text inside strings alone', () => {
    const input = '{"url": "https://x.test//p", "note": "/* not a comment */"}';
    assert.deepEqual(JSON.parse(stripJsonc(input)), {
      url: 'https://x.test//p',
      note: '/* not a comment */',
    });
  });

  test('survives escaped quotes', () => {
    const input = '{"a": "he said \\"//\\" loudly",}';
    assert.equal(JSON.parse(stripJsonc(input)).a, 'he said "//" loudly');
  });
});
