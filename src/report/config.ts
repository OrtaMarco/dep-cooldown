import type { Manager } from '../types.js';

export interface CooldownSetting {
  manager: Manager;
  /** The file the block belongs in. */
  file: string;
  key: string;
  unit: 'days' | 'minutes' | 'seconds';
  /** Number of `unit` in one day. */
  perDay: number;
  excludeKey: string;
  /** Default when the key is absent, as documented. */
  defaultValue: string;
  docs: string;
}

/**
 * Verified against each manager's own documentation on 2026-09-09.
 * The units genuinely differ; that is the entire point of `--config`.
 */
export const SETTINGS: Record<Manager, CooldownSetting> = {
  npm: {
    manager: 'npm',
    file: '.npmrc',
    key: 'min-release-age',
    unit: 'days',
    perDay: 1,
    excludeKey: 'min-release-age-exclude',
    defaultValue: 'null (disabled)',
    docs: 'https://docs.npmjs.com/cli/v11/using-npm/config#min-release-age',
  },
  pnpm: {
    manager: 'pnpm',
    file: 'pnpm-workspace.yaml',
    key: 'minimumReleaseAge',
    unit: 'minutes',
    perDay: 1440,
    excludeKey: 'minimumReleaseAgeExclude',
    defaultValue: '1440 (pnpm 11+), 0 before',
    docs: 'https://pnpm.io/settings/dependency-resolution#minimumreleaseage',
  },
  yarn: {
    manager: 'yarn',
    file: '.yarnrc.yml',
    key: 'npmMinimalAgeGate',
    unit: 'minutes',
    perDay: 1440,
    excludeKey: 'npmPreapprovedPackages',
    defaultValue: '1d',
    docs: 'https://yarnpkg.com/configuration/yarnrc#npmMinimalAgeGate',
  },
  bun: {
    manager: 'bun',
    file: 'bunfig.toml',
    key: 'minimumReleaseAge',
    unit: 'seconds',
    perDay: 86400,
    excludeKey: 'minimumReleaseAgeExcludes',
    defaultValue: 'unset (disabled)',
    docs: 'https://bun.com/docs/pm/cli/install#minimum-release-age',
  },
};

/** The threshold expressed in the manager's own unit. */
export function valueFor(manager: Manager, days: number): number {
  return Math.round(days * SETTINGS[manager].perDay);
}

function daysLabel(days: number): string {
  return days === 1 ? '1-day' : `${days}-day`;
}

/** Renders the paste-ready block for one manager. */
export function configBlock(manager: Manager, days: number): string {
  const s = SETTINGS[manager];
  const value = valueFor(manager, days);
  const label = days === 1 ? '1 day' : `${days} days`;

  if (manager === 'npm') {
    return [
      `# ${s.file} — npm CLI 11.10.0+`,
      `# ${s.key} is measured in DAYS. Docs: ${s.docs}`,
      `${s.key}=${value}`,
      `# Exempt what you publish yourself (repeat the key for each pattern):`,
      `# ${s.excludeKey}=@my-scope/*`,
    ].join('\n');
  }

  if (manager === 'pnpm') {
    return [
      `# ${s.file} — pnpm 10.16+`,
      `# ${s.key} is measured in MINUTES. Docs: ${s.docs}`,
      `${s.key}: ${value} # ${label}`,
      `${s.excludeKey}:`,
      `  - '@my-scope/*'`,
    ].join('\n');
  }

  if (manager === 'yarn') {
    return [
      `# ${s.file} — Yarn Berry (4.10+)`,
      `# ${s.key} is a duration; a bare number is read as MINUTES.`,
      `# Docs: ${s.docs}`,
      `${s.key}: ${value} # ${label}; the string form "${days}d" also works`,
      `${s.excludeKey}:`,
      `  - "@my-scope/*"`,
    ].join('\n');
  }

  return [
    `# ${s.file}`,
    `# ${s.key} is measured in SECONDS. Docs: ${s.docs}`,
    `[install]`,
    `${s.key} = ${value} # ${label}`,
    `${s.excludeKey} = ["@my-scope/*"]`,
  ].join('\n');
}

export const ALL_MANAGERS: Manager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** Renders one or every manager's block, with a unit-conversion table on `all`. */
export function renderConfig(target: Manager | 'all', days: number): string {
  if (target !== 'all') return `${configBlock(target, days)}\n`;

  const rows = ALL_MANAGERS.map((m) => {
    const s = SETTINGS[m];
    return `#   ${m.padEnd(5)} ${s.key.padEnd(18)} ${String(valueFor(m, days)).padStart(7)} ${s.unit}`;
  });

  const header = [
    `# A ${daysLabel(days)} cooldown, in each manager's own unit:`,
    ...rows,
  ].join('\n');

  return `${[header, ...ALL_MANAGERS.map((m) => configBlock(m, days))].join('\n\n')}\n`;
}
