export type {
  Manager,
  LockEntry,
  ParsedLockfile,
  PackageMeta,
  VersionMeta,
  AuditRow,
  AuditResult,
} from './types.js';

export {
  detectAndParse,
  parseNpmLock,
  parsePnpmLock,
  parseYarnLock,
  parseBunLock,
  parsePnpmKey,
  stripJsonc,
  NoLockfileError,
} from './lockfiles/index.js';

export { buildAudit, ageInDays, type AuditOptions } from './audit.js';

export {
  createRegistryClient,
  trimPackument,
  type FetchLike,
  type FetchOutcome,
  type ClientOptions,
} from './registry/client.js';
export { diskCache, nullCache, cacheDir, clearCache, type Cache } from './registry/cache.js';
export {
  resolveRegistry,
  registryFor,
  readExistingNpmCooldown,
  DEFAULT_REGISTRY,
  type RegistryConfig,
} from './registry/npmrc.js';

export {
  SETTINGS,
  ALL_MANAGERS,
  configBlock,
  renderConfig,
  valueFor,
  type CooldownSetting,
} from './report/config.js';
export { renderTable, type TableOptions } from './report/table.js';
export { pickPalette, ansi, noColor, type Palette } from './report/color.js';
