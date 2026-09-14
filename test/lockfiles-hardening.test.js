import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Namespace import on purpose: an export that does not exist yet fails its
// own tests instead of the whole file.
import * as api from '../dist/index.js';
import { fixture } from './helpers.js';

const { detectAndParse, parseNpmLock, parseYarnLock, parsePnpmLock, parseBunLock } = api;
const MTIME = '2026-09-01T00:00:00.000Z';
const hard = (...parts) => fixture('hardening', ...parts);

const ids = (lock) => lock.entries.map((e) => `${e.name}@${e.version}`).sort();
const entry = (lock, name, version) =>
  lock.entries.find((e) => e.name === name && (version === undefined || e.version === version));
const skipped = (lock) =>
  (lock.skipped ?? []).map((s) => `${s.reason}:${s.name}`).sort();

function npmLock(packages) {
  return JSON.stringify({ name: 'p', lockfileVersion: 3, packages: { '': {}, ...packages } });
}

const SEVEN = ['npm-v3', 'npm-v2', 'pnpm-v9', 'pnpm-v6', 'yarn-classic', 'yarn-berry', 'bun'];

describe('the seven original fixtures after hardening', () => {
  for (const dir of SEVEN) {
    test(`${dir}: nothing unverifiable, nothing skipped, no warnings`, async () => {
      const lock = await detectAndParse(fixture(dir));
      assert.equal(lock.entries.length, 14);
      assert.deepEqual(lock.entries.filter((e) => e.unverifiable), []);
      assert.deepEqual(lock.skipped ?? [], []);
      assert.deepEqual(lock.warnings ?? [], []);
    });
  }

  test('npm and yarn classic entries keep their resolved URL', async () => {
    for (const dir of ['npm-v3', 'npm-v2', 'yarn-classic']) {
      const lock = await detectAndParse(fixture(dir));
      const ms = entry(lock, 'ms');
      assert.match(ms.resolved ?? '', /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\/ms\/-\/ms-2\.1\.3\.tgz$/, dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. resolved
// ---------------------------------------------------------------------------

describe('verifyResolved', () => {
  const NPM = 'https://registry.npmjs.org';
  const MIRROR = 'https://npm.corp.example/artifactory/api/npm/npm-remote';
  const ok = [
    ['same registry', 'ms', '2.1.3', `${NPM}/ms/-/ms-2.1.3.tgz`, NPM],
    ['yarnpkg is npmjs', 'ms', '2.1.3', 'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz', NPM],
    ['npmjs is yarnpkg', 'ms', '2.1.3', `${NPM}/ms/-/ms-2.1.3.tgz`, 'https://registry.yarnpkg.com/'],
    ['scoped', '@babel/code-frame', '7.24.7', `${NPM}/@babel/code-frame/-/code-frame-7.24.7.tgz`, NPM],
    ['scope with %2f', '@babel/code-frame', '7.24.7', `${NPM}/@babel%2fcode-frame/-/code-frame-7.24.7.tgz`, NPM],
    ['scope with %2F', '@babel/code-frame', '7.24.7', `${NPM}/@babel%2Fcode-frame/-/code-frame-7.24.7.tgz`, NPM],
    ['query and yarn hash', 'ms', '2.1.3', 'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz?cache=1#574c8138ce1d2b5861f0b44579dbadd60c6615b2', NPM],
    ['http vs https', 'ms', '2.1.3', 'http://registry.npmjs.org/ms/-/ms-2.1.3.tgz', NPM],
    ['prerelease', 'vue', '3.5.0-beta.1', `${NPM}/vue/-/vue-3.5.0-beta.1.tgz`, NPM],
    ['mirror lockfile, mirror registry', 'ms', '2.1.3', `${MIRROR}/ms/-/ms-2.1.3.tgz`, MIRROR],
    ['public lockfile, mirror registry (replace-registry-host)', 'ms', '2.1.3', `${NPM}/ms/-/ms-2.1.3.tgz`, MIRROR],
    ['GitLab scoped basename', '@acme/ui', '1.0.0', 'https://gitlab.com/api/v4/projects/1/packages/npm/@acme/ui/-/@acme/ui-1.0.0.tgz', 'https://gitlab.com/api/v4/projects/1/packages/npm/'],
    ['GitHub Packages', '@acme/ui', '1.0.0', 'https://npm.pkg.github.com/download/@acme/ui/1.0.0/0123abcd', 'https://npm.pkg.github.com'],
  ];
  for (const [label, name, version, resolved, registry] of ok) {
    test(`accepts: ${label}`, () => {
      assert.equal(typeof api.verifyResolved, 'function', 'verifyResolved is exported');
      assert.equal(api.verifyResolved(name, version, resolved, registry), undefined);
    });
  }

  const bad = [
    ['another version on the registry', 'lodash', '4.17.21', `${NPM}/lodash/-/lodash-4.17.22.tgz`, NPM, /4\.17\.22/],
    ['a tarball with no registry shape', 'ms', '2.1.3', 'https://evil.example/ms-9.9.9.tgz', NPM, /not a registry tarball/],
    ['the right path on another host', 'ms', '2.1.3', 'https://evil.example/ms/-/ms-2.1.3.tgz', NPM, /evil\.example/],
    ['mirror lockfile audited against npmjs', 'ms', '2.1.3', `${MIRROR}/ms/-/ms-2.1.3.tgz`, NPM, /npm\.corp\.example/],
    ['another basename', 'ms', '2.1.3', `${NPM}/ms/-/lodash-2.1.3.tgz`, NPM, /lodash-2\.1\.3\.tgz under \/ms is not a ms tarball/],
    ['another package directory', 'ms', '2.1.3', `${NPM}/lodash/-/ms-2.1.3.tgz`, NPM, /not a ms tarball/],
    ['a suffix of the name', 'ms', '2.1.3', `${NPM}/xms/-/ms-2.1.3.tgz`, NPM, /not a ms tarball/],
    ['git', 'left-pad', '1.3.0', 'git+ssh://git@github.com/a/left-pad.git#0123', NPM, /git/],
    ['codeload', 'left-pad', '1.3.0', 'https://codeload.github.com/attacker/left-pad/tar.gz/0123456789abcdef', NPM, /git/],
    ['GitHub Packages, other version', '@acme/ui', '1.0.0', 'https://npm.pkg.github.com/download/@acme/ui/1.0.1/0123', 'https://npm.pkg.github.com', /1\.0\.1/],
  ];
  for (const [label, name, version, resolved, registry, why] of bad) {
    test(`rejects: ${label}`, () => {
      assert.equal(typeof api.verifyResolved, 'function', 'verifyResolved is exported');
      const reason = api.verifyResolved(name, version, resolved, registry);
      assert.equal(typeof reason, 'string');
      assert.match(reason, why);
    });
  }
});

describe('parsers do not trust version over resolved', () => {
  test('npm: resolved to another version is unverifiable, a foreign tarball is skipped', async () => {
    const lock = await detectAndParse(hard('npm-inject'));
    const lodash = entry(lock, 'lodash', '4.17.21');
    assert.ok(lodash, 'lodash stays in entries');
    assert.match(lodash.unverifiable ?? '', /4\.17\.22/);
    assert.equal(lodash.resolved, 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz');
    assert.equal(entry(lock, 'ms'), undefined, 'ms is not audited with the 2.1.3 date');
    assert.deepEqual(lock.skipped, [{ name: 'ms', spec: 'https://evil.example/ms-9.9.9.tgz', reason: 'tarball' }]);
  });

  test('npm: the lockfile npm ci accepted with a 4.17.22 tarball under 4.17.21', () => {
    // Verbatim from the review: `npm ci` installed 4.17.22 from this file.
    const raw = JSON.stringify({
      name: 'p',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'p', dependencies: { lodash: '^4.17.21' } },
        'node_modules/lodash': {
          version: '4.17.21',
          resolved: 'http://127.0.0.1:4881/lodash-4.17.22.tgz',
          integrity: 'sha512-9MgJN6G0aVMtaS8dcCGRALes20gu0VgPaw7iJDaGk0hIXGICMpGkZ9NUPf2zjqZtQmeJ+3At5sNK08E4LXwqOA==',
        },
      },
    });
    const lock = parseNpmLock(raw, '/x/package-lock.json', MTIME);
    assert.deepEqual(ids(lock), []);
    assert.deepEqual(skipped(lock), ['tarball:lodash']);
  });

  test('npm: a clean nested copy does not hide a tampered hoisted one', () => {
    const lock = parseNpmLock(
      npmLock({
        'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
        'node_modules/a/node_modules/lodash': {
          version: '4.17.21',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        },
        'node_modules/lodash': {
          version: '4.17.21',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz',
        },
      }),
      '/x/package-lock.json',
      MTIME,
    );
    assert.match(entry(lock, 'lodash').unverifiable ?? '', /4\.17\.22/);
  });

  test('npm: resolved absent is audited by name@version, with nothing to contradict', () => {
    const lock = parseNpmLock(
      npmLock({ 'node_modules/ms': { version: '2.1.3', integrity: 'sha512-x' } }),
      '/x/package-lock.json',
      MTIME,
    );
    assert.deepEqual(ids(lock), ['ms@2.1.3']);
    assert.equal(entry(lock, 'ms').unverifiable, undefined);
    assert.equal(entry(lock, 'ms').resolved, undefined);
  });

  test('npm: a mirror lockfile parses clean (the host is checked later, against the registry)', () => {
    const lock = parseNpmLock(
      npmLock({
        'node_modules/ms': {
          version: '2.1.3',
          resolved: 'https://npm.corp.example/repository/npm/ms/-/ms-2.1.3.tgz?auth=1',
        },
      }),
      '/x/package-lock.json',
      MTIME,
    );
    assert.equal(entry(lock, 'ms').unverifiable, undefined);
    assert.equal(entry(lock, 'ms').resolved, 'https://npm.corp.example/repository/npm/ms/-/ms-2.1.3.tgz?auth=1');
  });

  test('npm v1: resolved is checked in the legacy dependencies tree too', () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz' },
        ms: { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz' },
        old: { version: '1.0.0' },
      },
    });
    const lock = parseNpmLock(raw, '/x/package-lock.json', MTIME);
    assert.match(entry(lock, 'lodash').unverifiable ?? '', /4\.17\.22/);
    assert.equal(entry(lock, 'ms').unverifiable, undefined);
    assert.equal(entry(lock, 'old').unverifiable, undefined);
  });

  test('yarn classic: a github: range resolved on codeload is skipped as git', async () => {
    const lock = await detectAndParse(hard('yarn-gh'));
    assert.equal(entry(lock, 'left-pad'), undefined, 'no registry date for left-pad');
    assert.ok(
      (lock.skipped ?? []).some(
        (s) => s.name === 'left-pad' && s.reason === 'git' && s.spec.includes('codeload.github.com'),
      ),
    );
    assert.equal(entry(lock, 'fresh').resolved, 'https://registry.yarnpkg.com/fresh/-/fresh-1.0.0.tgz#abc');
  });

  test('yarn classic: resolved to another version is unverifiable', () => {
    const raw = `# yarn lockfile v1\n\nlodash@^4.17.21:\n  version "4.17.21"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.22.tgz#abc"\n\nms@^2.1.3:\n  version "2.1.3"\n  resolved "https://evil.example/ms-9.9.9.tgz"\n`;
    const lock = parseYarnLock(raw, '/x/yarn.lock', MTIME, new Set(['lodash', 'ms']));
    assert.match(entry(lock, 'lodash').unverifiable ?? '', /4\.17\.22/);
    assert.equal(entry(lock, 'ms'), undefined);
    assert.deepEqual(skipped(lock), ['tarball:ms']);
  });

  test('yarn berry and bun: a registry-shaped tarball dependency is audited with its resolved URL', async () => {
    for (const dir of ['real-yarn4-ws', 'real-bun1-ws']) {
      const lock = await detectAndParse(hard(dir));
      const hasFlag = entry(lock, 'has-flag', '3.0.0');
      assert.ok(hasFlag, dir);
      assert.equal(hasFlag.resolved, 'https://registry.npmjs.org/has-flag/-/has-flag-3.0.0.tgz', dir);
      assert.equal(hasFlag.unverifiable, undefined, dir);
    }
  });

  test('pnpm: a tarball URL in resolution is checked like resolved', () => {
    const raw = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: 4.17.21\n        version: 4.17.21\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-x, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz}\n\n  ms@2.1.3:\n    resolution: {integrity: sha512-x, tarball: https://registry.npmjs.org/ms/-/ms-2.1.3.tgz}\n\nsnapshots:\n\n  lodash@4.17.21: {}\n\n  ms@2.1.3: {}\n`;
    const lock = parsePnpmLock(raw, '/x/pnpm-lock.yaml', MTIME);
    assert.match(entry(lock, 'lodash').unverifiable ?? '', /4\.17\.22/);
    assert.equal(entry(lock, 'ms').unverifiable, undefined);
    assert.equal(entry(lock, 'ms').resolved, 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz');
  });
});

// ---------------------------------------------------------------------------
// 2. Yarn classic: a dependency called `version`
// ---------------------------------------------------------------------------

describe('yarn: dependencies named like block fields', () => {
  test('a dependency called version does not overwrite the package version', async () => {
    const lock = await detectAndParse(hard('yarn-gh'));
    assert.ok(entry(lock, 'fresh', '1.0.0'), 'fresh@1.0.0 is still reported');
    assert.equal(lock.entries.filter((e) => e.name === 'fresh').length, 1);
  });

  test('neither do dependencies called resolved or resolution', () => {
    const classic = `# yarn lockfile v1\n\nfresh@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/fresh/-/fresh-1.0.0.tgz"\n  dependencies:\n    resolved "^9.0.0"\n    version "^2.0.0"\n`;
    const c = parseYarnLock(classic, '/x/yarn.lock', MTIME, new Set());
    assert.deepEqual(ids(c), ['fresh@1.0.0']);
    assert.equal(entry(c, 'fresh').resolved, 'https://registry.yarnpkg.com/fresh/-/fresh-1.0.0.tgz');

    const berry = `__metadata:\n  version: 8\n\n"fresh@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "fresh@npm:1.0.0"\n  dependencies:\n    resolution: "npm:^3.0.0"\n    version: "npm:^2.0.0"\n  languageName: node\n  linkType: hard\n`;
    const b = parseYarnLock(berry, '/x/yarn.lock', MTIME, new Set());
    assert.deepEqual(ids(b), ['fresh@1.0.0']);
  });

  test('CRLF lockfiles still parse', () => {
    const classic = '# yarn lockfile v1\r\n\r\nms@^2.1.3:\r\n  version "2.1.3"\r\n  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz"\r\n';
    assert.deepEqual(ids(parseYarnLock(classic, '/x/yarn.lock', MTIME, new Set())), ['ms@2.1.3']);
  });
});

// ---------------------------------------------------------------------------
// 3. pnpm 5.4 keys with a peer suffix
// ---------------------------------------------------------------------------

describe('pnpm lockfile v5 with peer suffixes', () => {
  test('review fixture: fresh, @scope/a and ms come out with their real names', async () => {
    const lock = await detectAndParse(hard('pnpm-v5'));
    assert.deepEqual(ids(lock), ['@scope/a@1.0.0', 'fresh@1.0.0', 'ms@2.1.3']);
    assert.equal(entry(lock, 'fresh').direct, true);
  });

  test('real pnpm 7 lockfile (5.4): peers, aliases, tarballs, links and workspaces', async () => {
    const lock = await detectAndParse(hard('real-pnpm7-ws'));
    assert.equal(lock.format, 'pnpm-lock.yaml v5');
    assert.deepEqual(ids(lock), [
      'fresh@1.0.0',
      'has-flag@3.0.0',
      'is-number@7.0.0',
      'js-tokens@4.0.0',
      'loose-envify@1.4.0',
      'ms@2.1.2',
      'ms@2.1.3',
      'react@18.2.0',
      'use-sync-external-store@1.2.0',
    ]);
    assert.deepEqual(skipped(lock), ['file:local-lib', 'git:left-pad', 'link:link-lib', 'workspace:wsdep']);
  });

  test('a git commit that starts with a digit is not read as a version', () => {
    const raw = `lockfileVersion: 5.4\n\nspecifiers:\n  left-pad: https://codeload.github.com/a/left-pad/tar.gz/0123456789abcdef\n\ndependencies:\n  left-pad: '@codeload.github.com/a/left-pad/tar.gz/0123456789abcdef'\n\npackages:\n\n  '@codeload.github.com/a/left-pad/tar.gz/0123456789abcdef':\n    resolution: {tarball: https://codeload.github.com/a/left-pad/tar.gz/0123456789abcdef}\n    name: left-pad\n    version: 1.3.0\n    dev: false\n\n  github.com/a/other/0123456789abcdef:\n    resolution: {tarball: https://codeload.github.com/a/other/tar.gz/0123456789abcdef}\n    name: other\n    version: 2.0.0\n    dev: false\n`;
    const lock = parsePnpmLock(raw, '/x/pnpm-lock.yaml', MTIME);
    assert.deepEqual(ids(lock), []);
    assert.deepEqual(skipped(lock), ['git:left-pad', 'git:other']);
  });
});

// ---------------------------------------------------------------------------
// 4. --prod with a package that is dev in one importer and prod in another
// ---------------------------------------------------------------------------

describe('dev only when no importer needs the package in production', () => {
  test('pnpm workspace: fresh is dev at the root and prod in packages/app', async () => {
    const lock = await detectAndParse(hard('pnpm-ws'));
    assert.equal(entry(lock, 'fresh').dev, false);
  });

  test('bun workspace: same shape', async () => {
    const lock = await detectAndParse(hard('bun-ws'));
    assert.equal(entry(lock, 'fresh').dev, false);
  });

  test('real lockfiles of the same workspace agree fresh is not dev-only', async () => {
    for (const dir of ['real-npm11-ws', 'real-pnpm9-ws', 'real-pnpm7-ws', 'real-bun1-ws', 'real-yarn1-ws', 'real-yarn4-ws']) {
      const lock = await detectAndParse(hard(dir));
      assert.equal(entry(lock, 'fresh').dev, false, dir);
    }
  });

  test('npm: devOptional is not dev-only (npm --omit=dev still installs it)', () => {
    const lock = parseNpmLock(
      npmLock({
        'node_modules/fsevents': {
          version: '2.3.3',
          resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz',
          devOptional: true,
        },
        'node_modules/is-number': {
          version: '7.0.0',
          resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
          dev: true,
        },
      }),
      '/x/package-lock.json',
      MTIME,
    );
    assert.equal(entry(lock, 'fsevents').dev, false);
    assert.equal(entry(lock, 'is-number').dev, true);
  });

  test('yarn: a name in both dependencies and devDependencies is not dev', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-'));
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ dependencies: { ms: '^2.1.3' }, devDependencies: { ms: '^2.1.3', fresh: '1.0.0' } }),
      );
      await writeFile(
        join(dir, 'yarn.lock'),
        `# yarn lockfile v1\n\nfresh@1.0.0:\n  version "1.0.0"\n\nms@^2.1.3:\n  version "2.1.3"\n`,
      );
      const lock = await detectAndParse(dir);
      assert.equal(entry(lock, 'ms').dev, false);
      assert.equal(entry(lock, 'fresh').dev, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Several lockfiles in one directory
// ---------------------------------------------------------------------------

describe('several lockfiles', () => {
  test('npm-shrinkwrap.json wins over package-lock.json, as in npm', async () => {
    const lock = await detectAndParse(hard('npm-shrink'));
    assert.ok(lock.path.endsWith('npm-shrinkwrap.json'));
    assert.equal(lock.format, 'npm-shrinkwrap.json v3');
    assert.deepEqual(ids(lock), ['fresh@1.0.0']);
  });

  test('the report says which one was read and which were ignored', async () => {
    const lock = await detectAndParse(hard('npm-shrink'));
    assert.equal(lock.warnings?.length, 1);
    assert.match(lock.warnings[0], /read npm-shrinkwrap\.json/);
    assert.match(lock.warnings[0], /ignored package-lock\.json/);
  });

  test('packageManager picks among lockfiles of different managers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.9.2' }));
      await writeFile(join(dir, 'pnpm-lock.yaml'), await readFile(fixture('pnpm-v9', 'pnpm-lock.yaml'), 'utf8'));
      await writeFile(join(dir, 'yarn.lock'), await readFile(fixture('yarn-berry', 'yarn.lock'), 'utf8'));
      const lock = await detectAndParse(dir);
      assert.equal(lock.manager, 'yarn');
      assert.match(lock.warnings?.[0] ?? '', /read yarn\.lock.*packageManager.*ignored pnpm-lock\.yaml/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an explicit lockfile is read without a warning', async () => {
    const lock = await detectAndParse(hard('npm-shrink'), 'package-lock.json');
    assert.deepEqual(ids(lock), ['is-number@7.0.0']);
    assert.deepEqual(lock.warnings ?? [], []);
  });
});

// ---------------------------------------------------------------------------
// 6. Workspace members
// ---------------------------------------------------------------------------

describe('workspace members are skipped, not looked up', () => {
  test('npm: packages/* keys and link: true entries', async () => {
    const lock = await detectAndParse(hard('npm-ws'));
    assert.deepEqual(ids(lock), []);
    assert.deepEqual(skipped(lock), ['workspace:my-workspace', 'workspace:other-ws']);
  });

  test('real npm 11 workspace', async () => {
    const lock = await detectAndParse(hard('real-npm11-ws'));
    assert.deepEqual(ids(lock), ['fresh@1.0.0', 'has-flag@3.0.0', 'is-number@7.0.0', 'ms@2.1.3']);
    assert.deepEqual(lock.skipped, [
      { name: 'local-lib', spec: 'local-lib', reason: 'file' },
      { name: 'app', spec: 'packages/app', reason: 'workspace' },
      { name: 'left-pad', spec: 'git+ssh://git@github.com/stevemao/left-pad.git#ff8e7ba8b4122829cf66125ca8445cac7f073bce', reason: 'git' },
    ]);
  });

  test('pnpm: link: and workspace: importer versions', async () => {
    const lock = await detectAndParse(hard('real-pnpm9-ws'));
    assert.deepEqual(skipped(lock), ['file:local-lib', 'git:left-pad', 'link:link-lib', 'workspace:wsdep']);
  });

  test('bun: workspace members', async () => {
    const lock = await detectAndParse(hard('bun-ws'));
    assert.deepEqual(ids(lock), ['fresh@1.0.0']);
    const real = await detectAndParse(hard('real-bun1-ws'));
    assert.ok(skipped(real).includes('workspace:app'));
  });

  test('yarn berry: workspace members, but not the root project', async () => {
    const lock = await detectAndParse(hard('real-yarn4-ws'));
    assert.ok(skipped(lock).includes('workspace:app'));
    assert.ok(!skipped(lock).includes('workspace:root'));
  });
});

// ---------------------------------------------------------------------------
// 7. Aliases: the name looked up is the published one
// ---------------------------------------------------------------------------

describe('aliases resolve to the published name', () => {
  test('yarn classic: foo@npm:bar@^1.0.0 is bar', async () => {
    const lock = await detectAndParse(hard('yarn-gh'));
    assert.ok(entry(lock, 'bar', '1.0.0'));
    assert.ok(!lock.entries.some((e) => e.name.includes('@npm:')));
    assert.equal(entry(lock, 'bar').direct, true, 'foo is declared in package.json');
  });

  test('yarn classic: scoped alias targets', () => {
    const raw = `# yarn lockfile v1\n\n"ui@npm:@acme/ui@^1.0.0":\n  version "1.2.0"\n  resolved "https://registry.yarnpkg.com/@acme/ui/-/ui-1.2.0.tgz"\n`;
    const lock = parseYarnLock(raw, '/x/yarn.lock', MTIME, new Set(['ui']));
    assert.deepEqual(ids(lock), ['@acme/ui@1.2.0']);
    assert.equal(entry(lock, '@acme/ui').direct, true);
    assert.equal(entry(lock, '@acme/ui').unverifiable, undefined);
  });

  test('every manager reports the aliased packages under their real names, direct', async () => {
    const cases = {
      'real-npm11-ws': ['is-number'],
      'real-yarn1-ws': ['is-number'],
      'real-yarn4-ws': ['is-number'],
      'real-pnpm9-ws': ['is-number', 'ms@2.1.2'],
      'real-pnpm7-ws': ['is-number', 'ms@2.1.2'],
      'real-bun1-ws': ['is-number', 'ms@2.1.2'],
    };
    for (const [dir, names] of Object.entries(cases)) {
      const lock = await detectAndParse(hard(dir));
      assert.ok(!lock.entries.some((e) => e.name === 'foo' || e.name === 'bar'), dir);
      for (const n of names) {
        const [name, version] = n.split('@');
        const e = entry(lock, name, version);
        assert.ok(e, `${dir}: ${n}`);
        assert.equal(e.direct, true, `${dir}: ${n} is direct through its alias`);
      }
    }
  });

  test('pnpm: an alias whose key is the real package', () => {
    const raw = `lockfileVersion: '6.0'\n\ndependencies:\n  foo:\n    specifier: npm:bar@1.0.0\n    version: /bar@1.0.0\n\npackages:\n\n  /bar@1.0.0:\n    resolution: {integrity: sha512-x}\n    dev: false\n`;
    const lock = parsePnpmLock(raw, '/x/pnpm-lock.yaml', MTIME);
    assert.deepEqual(ids(lock), ['bar@1.0.0']);
    assert.equal(entry(lock, 'bar').direct, true);
  });

  test('names no registry could serve are skipped', () => {
    const raw = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/x': { name: '..', version: '1.0.0' },
        'node_modules/y': { name: 'young?x=1#', version: '1.0.0' },
        'node_modules/z': { name: '@scope/../../etc', version: '1.0.0' },
      },
    });
    const lock = parseNpmLock(raw, '/x/package-lock.json', MTIME);
    assert.deepEqual(ids(lock), []);
    assert.equal(lock.skipped?.length, 3);
    assert.ok(lock.skipped.every((s) => s.reason === 'other'));
  });
});

// ---------------------------------------------------------------------------
// 8. Nothing disappears in silence
// ---------------------------------------------------------------------------

describe('everything left out is listed in skipped', () => {
  test('npm: git, file: and link', () => {
    const raw = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { x: 'github:a/x', y: 'file:../y', t: 'file:t-1.0.0.tgz' } },
        'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@github.com/a/x.git#0123' },
        'node_modules/y': { resolved: '../y', link: true },
        'node_modules/t': { version: '1.0.0', resolved: 'file:t-1.0.0.tgz' },
        '../y': { name: 'y', version: '0.0.1' },
      },
    });
    const lock = parseNpmLock(raw, '/x/package-lock.json', MTIME);
    assert.deepEqual(ids(lock), []);
    assert.deepEqual(skipped(lock), ['file:t', 'file:y', 'git:x']);
  });

  test('npm v1: git, file and aliases in the legacy tree', () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        x: { version: 'github:a/x#0123', from: 'github:a/x' },
        y: { version: 'file:../y' },
        foo: { version: 'npm:is-number@7.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz' },
      },
    });
    const lock = parseNpmLock(raw, '/x/package-lock.json', MTIME);
    assert.deepEqual(ids(lock), ['is-number@7.0.0']);
    assert.equal(entry(lock, 'is-number').direct, true);
    assert.deepEqual(skipped(lock), ['file:y', 'git:x']);
  });

  test('yarn classic real lockfile: git, file:, and the rest', async () => {
    const lock = await detectAndParse(hard('real-yarn1-ws'));
    assert.deepEqual(ids(lock), ['fresh@1.0.0', 'has-flag@3.0.0', 'is-number@7.0.0', 'ms@2.1.3']);
    assert.deepEqual(skipped(lock), ['file:local-lib', 'git:left-pad']);
  });

  test('yarn berry real lockfile: git, file:, link:, portal:, workspace:; patch: audits its base', async () => {
    const lock = await detectAndParse(hard('real-yarn4-ws'));
    assert.deepEqual(ids(lock), ['fresh@1.0.0', 'has-flag@3.0.0', 'is-number@7.0.0', 'ms@2.1.3']);
    assert.deepEqual(skipped(lock), [
      'file:local-lib',
      'git:left-pad',
      'link:link-lib',
      'link:portal-lib',
      'workspace:app',
    ]);
    assert.equal(entry(lock, 'ms').direct, true);
  });

  test('yarn berry: patch: over a git base is skipped; builtin patches audit the npm base', () => {
    const raw = `__metadata:\n  version: 8\n\n"typescript@patch:typescript@npm%3A^5.4.0#optional!builtin<compat/typescript>":\n  version: 5.4.5\n  resolution: "typescript@patch:typescript@npm%3A5.4.5#optional!builtin<compat/typescript>::version=5.4.5&hash=5adc0c"\n  languageName: node\n  linkType: hard\n\n"x@patch:x@https%3A//github.com/a/x.git%23commit=0123#./x.patch::locator=root%40workspace%3A.":\n  version: 1.0.0\n  resolution: "x@patch:x@https%3A//github.com/a/x.git%23commit=0123#./x.patch::version=1.0.0&hash=1&locator=root%40workspace%3A."\n  languageName: node\n  linkType: hard\n`;
    const lock = parseYarnLock(raw, '/x/yarn.lock', MTIME, new Set());
    assert.deepEqual(ids(lock), ['typescript@5.4.5']);
    assert.deepEqual(skipped(lock), ['git:x']);
  });

  test('pnpm real lockfiles: nothing that is not in entries goes unlisted', async () => {
    for (const dir of ['real-pnpm9-ws', 'real-pnpm7-ws']) {
      const lock = await detectAndParse(hard(dir));
      assert.equal(lock.entries.length + lock.skipped.filter((s) => s.reason !== 'link' && s.reason !== 'workspace').length, 11, dir);
    }
  });

  test('bun real lockfile: git, file: and workspace:', async () => {
    const lock = await detectAndParse(hard('real-bun1-ws'));
    assert.deepEqual(ids(lock), [
      'fresh@1.0.0',
      'has-flag@3.0.0',
      'is-number@7.0.0',
      'js-tokens@4.0.0',
      'loose-envify@1.4.0',
      'ms@2.1.2',
      'ms@2.1.3',
      'react@18.2.0',
      'use-sync-external-store@1.2.0',
    ]);
    assert.deepEqual(skipped(lock), ['file:local-lib', 'git:left-pad', 'workspace:app']);
  });

  test('bun: link: and a foreign tarball', () => {
    const raw = `{"lockfileVersion":1,"workspaces":{"":{"dependencies":{"l":"link:l","t":"https://x.example/t.tgz"}}},"packages":{"l":["l@link:l",{}],"t":["t@https://x.example/t.tgz",{}]}}`;
    const lock = parseBunLock(raw, '/x/bun.lock', MTIME);
    assert.deepEqual(ids(lock), []);
    assert.deepEqual(skipped(lock), ['link:l', 'tarball:t']);
  });
});

// 9. bun.lock JSONC: see the stripJsonc tests in lockfiles.test.js.
test('bun: a git locator whose ref contains ", }" keeps it', () => {
  const raw = `{"lockfileVersion":1,"workspaces":{"":{"dependencies":{"g":"github:a/g#x, }",},},},"packages":{"g":["g@github:a/g#x, }",{},],},}`;
  const lock = parseBunLock(raw, '/x/bun.lock', MTIME);
  assert.deepEqual(lock.skipped, [{ name: 'g', spec: 'github:a/g#x, }', reason: 'git' }]);
});

describe('yarn workspace globs', () => {
  test('yarn workspace globs that match nothing do not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dep-cooldown-'));
    try {
      await mkdir(join(dir, 'packages'));
      await writeFile(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'tools/**'], dependencies: { ms: '2.1.3' } }));
      await writeFile(join(dir, 'yarn.lock'), `# yarn lockfile v1\n\nms@2.1.3:\n  version "2.1.3"\n`);
      const lock = await detectAndParse(dir);
      assert.equal(entry(lock, 'ms').dev, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
