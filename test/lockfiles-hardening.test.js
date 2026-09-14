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
