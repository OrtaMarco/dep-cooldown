import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, ALL_MANAGERS, configBlock, renderConfig, valueFor } from '../dist/index.js';

/**
 * These numbers are the reason the tool exists: the four managers accept the
 * same idea in four different units. Verified against each manager's own docs
 * on 2026-09-09 (URLs live in SETTINGS and in the README).
 */
describe('unit conversion', () => {
  test('a 7-day cooldown in each manager unit', () => {
    assert.equal(valueFor('npm', 7), 7); // days
    assert.equal(valueFor('pnpm', 7), 10080); // minutes
    assert.equal(valueFor('yarn', 7), 10080); // minutes
    assert.equal(valueFor('bun', 7), 604800); // seconds
  });

  test('a 1-day cooldown', () => {
    assert.equal(valueFor('npm', 1), 1);
    assert.equal(valueFor('pnpm', 1), 1440);
    assert.equal(valueFor('yarn', 1), 1440);
    assert.equal(valueFor('bun', 1), 86400);
  });

  test('fractional days round to a whole unit', () => {
    assert.equal(valueFor('npm', 0.5), 1);
    assert.equal(valueFor('pnpm', 0.5), 720);
    assert.equal(valueFor('bun', 0.5), 43200);
  });

  test('every manager declares its unit, file, exclude key and docs URL', () => {
    for (const m of ALL_MANAGERS) {
      const s = SETTINGS[m];
      assert.ok(['days', 'minutes', 'seconds'].includes(s.unit), m);
      assert.ok(s.file.length > 0, m);
      assert.ok(s.key.length > 0, m);
      assert.ok(s.excludeKey.length > 0, m);
      assert.match(s.docs, /^https:\/\//, m);
    }
  });

  test('the exact keys and units, pinned', () => {
    assert.equal(SETTINGS.npm.key, 'min-release-age');
    assert.equal(SETTINGS.npm.unit, 'days');
    assert.equal(SETTINGS.npm.excludeKey, 'min-release-age-exclude');

    assert.equal(SETTINGS.pnpm.key, 'minimumReleaseAge');
    assert.equal(SETTINGS.pnpm.unit, 'minutes');
    assert.equal(SETTINGS.pnpm.excludeKey, 'minimumReleaseAgeExclude');

    assert.equal(SETTINGS.yarn.key, 'npmMinimalAgeGate');
    assert.equal(SETTINGS.yarn.unit, 'minutes');
    // Yarn's escape hatch is not named after the age gate.
    assert.equal(SETTINGS.yarn.excludeKey, 'npmPreapprovedPackages');

    assert.equal(SETTINGS.bun.key, 'minimumReleaseAge');
    assert.equal(SETTINGS.bun.unit, 'seconds');
    assert.equal(SETTINGS.bun.excludeKey, 'minimumReleaseAgeExcludes');
  });
});

describe('configBlock', () => {
  test('npm emits an ini line in days', () => {
    const block = configBlock('npm', 7);
    assert.match(block, /^min-release-age=7$/m);
    assert.match(block, /\.npmrc/);
  });

  test('pnpm emits YAML in minutes with the exclusion list', () => {
    const block = configBlock('pnpm', 7);
    assert.match(block, /^minimumReleaseAge: 10080 # 7 days$/m);
    assert.match(block, /^minimumReleaseAgeExclude:$/m);
    assert.match(block, /pnpm-workspace\.yaml/);
  });

  test('yarn emits minutes and says the duration string also works', () => {
    const block = configBlock('yarn', 7);
    assert.match(block, /^npmMinimalAgeGate: 10080/m);
    assert.match(block, /"7d"/);
    assert.match(block, /npmPreapprovedPackages/);
    assert.match(block, /\.yarnrc\.yml/);
  });

  test('bun emits TOML under [install], in seconds', () => {
    const block = configBlock('bun', 7);
    assert.match(block, /^\[install\]$/m);
    assert.match(block, /^minimumReleaseAge = 604800 # 7 days$/m);
    assert.match(block, /minimumReleaseAgeExcludes = \["@my-scope\/\*"\]/);
  });

  test('each block cites its own documentation URL', () => {
    for (const m of ALL_MANAGERS) {
      assert.ok(configBlock(m, 7).includes(SETTINGS[m].docs), m);
    }
  });
});

describe('renderConfig', () => {
  test('all includes a conversion table and every block', () => {
    const out = renderConfig('all', 7);
    assert.match(out, /A 7-day cooldown, in each manager's own unit/);
    for (const m of ALL_MANAGERS) {
      assert.ok(out.includes(SETTINGS[m].file), m);
    }
    assert.match(out, /min-release-age {10}7 days/);
    assert.match(out, /minimumReleaseAge {4}10080 minutes/);
    assert.match(out, /minimumReleaseAge {3}604800 seconds/);
    assert.ok(out.endsWith('\n'));
    assert.ok(!out.includes('\n\n\n'), 'no triple blank lines');
  });

  test('a single target prints only that block', () => {
    const out = renderConfig('bun', 3);
    assert.match(out, /minimumReleaseAge = 259200 # 3 days/);
    assert.ok(!out.includes('min-release-age='));
  });
});
