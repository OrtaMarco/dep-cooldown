import type { AuditResult, AuditRow, ParsedLockfile } from './types.js';
import type { FetchOutcome } from './registry/client.js';

export interface AuditOptions {
  minAgeDays: number;
  /** Reference date for the age calculation. Defaults to now. */
  asOf?: Date;
  asOfExplicit?: boolean;
  onlyDirect?: boolean;
  /** Drop entries the lockfile marks as development-only. */
  prodOnly?: boolean;
  registry: string;
  offline?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days, one decimal, never negative-zero. */
export function ageInDays(published: string, asOf: Date): number {
  const delta = asOf.getTime() - Date.parse(published);
  return Math.round((delta / DAY_MS) * 10) / 10;
}

/**
 * Joins lockfile entries with registry metadata into the report rows.
 * Pure: everything that touches the network or the disk happens before it,
 * which is what makes the whole pipeline testable with a mock registry.
 */
export function buildAudit(
  lock: ParsedLockfile,
  meta: Map<string, FetchOutcome>,
  options: AuditOptions,
): AuditResult {
  const asOf = options.asOf ?? new Date();
  const rows: AuditRow[] = [];

  for (const entry of lock.entries) {
    if (options.onlyDirect && !entry.direct) continue;
    if (options.prodOnly && entry.dev === true) continue;

    const outcome = meta.get(entry.name);
    const published = outcome?.meta?.time[entry.version] ?? null;
    const versionMeta = outcome?.meta?.versions[entry.version];
    const age = published ? ageInDays(published, asOf) : null;

    const row: AuditRow = {
      name: entry.name,
      version: entry.version,
      direct: entry.direct,
      dev: entry.dev,
      published,
      ageDays: age,
      provenance: outcome?.meta ? (versionMeta?.provenance ?? false) : null,
      deprecated: versionMeta?.deprecated ?? null,
      young: age !== null && age < options.minAgeDays,
    };
    if (!published) {
      row.error = outcome?.error ?? (outcome?.meta ? 'version not listed in registry' : 'no data');
    }
    rows.push(row);
  }

  // Youngest first — that is the list a reader acts on.
  rows.sort((a, b) => {
    if (a.ageDays === null && b.ageDays === null) return a.name.localeCompare(b.name);
    if (a.ageDays === null) return 1;
    if (b.ageDays === null) return -1;
    if (a.ageDays !== b.ageDays) return a.ageDays - b.ageDays;
    return a.name.localeCompare(b.name);
  });

  return {
    manager: lock.manager,
    lockfile: lock.path,
    format: lock.format,
    lockfileModified: lock.mtime,
    registry: options.registry,
    asOf: asOf.toISOString(),
    asOfExplicit: options.asOfExplicit ?? false,
    minAgeDays: options.minAgeDays,
    offline: options.offline ?? false,
    totals: {
      packages: rows.length,
      direct: rows.filter((r) => r.direct).length,
      young: rows.filter((r) => r.young).length,
      deprecated: rows.filter((r) => r.deprecated).length,
      withProvenance: rows.filter((r) => r.provenance === true).length,
      unknown: rows.filter((r) => r.ageDays === null).length,
      skipped: lock.skipped?.length ?? 0,
    },
    rows,
    skipped: lock.skipped ?? [],
  };
}
