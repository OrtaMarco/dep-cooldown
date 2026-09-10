/** Package managers whose lockfiles and cooldown settings we know about. */
export type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** One resolved package@version taken from a lockfile. */
export interface LockEntry {
  name: string;
  version: string;
  /** Listed in the root manifest's dependency fields. */
  direct: boolean;
  /**
   * `true` when the lockfile says the entry only exists for development,
   * `false` when it is a production dependency, `null` when the format
   * cannot tell (Yarn classic).
   */
  dev: boolean | null;
}

export interface ParsedLockfile {
  manager: Manager;
  /** Absolute path of the lockfile that was read. */
  path: string;
  /** Human label, e.g. `package-lock.json v3` or `pnpm-lock.yaml v9`. */
  format: string;
  /** Last modification time of the lockfile, ISO 8601. */
  mtime: string;
  entries: LockEntry[];
}

/** The slice of a packument we actually need, and the only thing we cache. */
export interface PackageMeta {
  name: string;
  /** version -> ISO publish date, as reported by the registry's `time` map. */
  time: Record<string, string>;
  /** version -> flags derived from the registry document. */
  versions: Record<string, VersionMeta>;
  /** When this record was written to the cache, ISO 8601. */
  fetchedAt: string;
}

export interface VersionMeta {
  /** `dist.attestations` present => the version was published with provenance. */
  provenance: boolean;
  /** The deprecation message, when the version is deprecated. */
  deprecated?: string;
}

export interface AuditRow {
  name: string;
  version: string;
  direct: boolean;
  dev: boolean | null;
  /** ISO publish date, or `null` when unknown (offline, 404, unpublished). */
  published: string | null;
  /** Age in days at the reference date, rounded to one decimal. */
  ageDays: number | null;
  /** `null` when the registry record could not be read. */
  provenance: boolean | null;
  deprecated: string | null;
  /** `ageDays` is below the configured threshold. */
  young: boolean;
  /** Why this row has no data, when it has none. */
  error?: string;
}

export interface AuditResult {
  manager: Manager;
  lockfile: string;
  format: string;
  /** Lockfile mtime, ISO 8601 — the suggestion for `--as-of`. */
  lockfileModified: string;
  registry: string;
  /** The date ages were measured against, ISO 8601. */
  asOf: string;
  /** `true` when `asOf` came from `--as-of` rather than the clock. */
  asOfExplicit: boolean;
  minAgeDays: number;
  offline: boolean;
  totals: {
    packages: number;
    direct: number;
    young: number;
    deprecated: number;
    withProvenance: number;
    unknown: number;
  };
  rows: AuditRow[];
}
