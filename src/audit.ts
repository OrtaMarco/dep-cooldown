import type { AuditResult, AuditRow, LockEntry, ParsedLockfile } from './types.js';
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

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2})))?$/;

/**
 * Epoch milliseconds for an ISO 8601 calendar date (`2026-09-01`, read as UTC)
 * or date-time with a zone (`2026-09-01T16:12:01Z`, `…+02:00`), or `null`.
 *
 * `Date.parse` alone is not a validator: it reads `"7"` and `"Sep 1"` as 2001,
 * rolls `2026-02-31` into March and accepts `24:00`. A date-time without a zone
 * is refused because JavaScript would read it in the machine's local zone.
 */
export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, , , , oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59)) return null;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Days between `published` and `asOf`, floored to one decimal so the figure
 * never overstates an age. Negative when `published` is after `asOf`; `NaN`
 * when `published` is not an ISO 8601 timestamp.
 */
export function ageInDays(published: string, asOf: Date): number {
  const ms = parseIsoTimestamp(published);
  if (ms === null) return Number.NaN;
  return floorTo(asOf.getTime() - ms, 1);
}

/** `deltaMs` in days, floored to `decimals` places (0-5 keep the division exact). */
function floorTo(deltaMs: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(deltaMs / (DAY_MS / scale)) / scale + 0;
}

/**
 * The age shown for a row. One decimal is enough almost always; near a
 * threshold with more decimals than that, add places until the figure agrees
 * with the verdict, so a YOUNG row never reads `7.0` against `--min-age 7`.
 */
function displayAge(deltaMs: number, minAgeDays: number, young: boolean): number {
  for (let decimals = 1; decimals <= 5; decimals++) {
    const shown = floorTo(deltaMs, decimals);
    if (shown < minAgeDays === young) return shown;
  }
  return deltaMs / DAY_MS;
}

function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The lockfile entries `--only-direct` and `--prod` keep. */
export function selectEntries(
  lock: ParsedLockfile,
  options: Pick<AuditOptions, 'onlyDirect' | 'prodOnly'>,
): LockEntry[] {
  return lock.entries.filter(
    (entry) => !(options.onlyDirect && !entry.direct) && !(options.prodOnly && entry.dev === true),
  );
}

/**
 * Joins lockfile entries with registry metadata into the report rows.
 * Pure: everything that touches the network or the disk happens before it,
 * which is what makes the whole pipeline testable with a mock registry.
 *
 * A row is only ever young, old enough or unknown. Anything that does not
 * yield a valid publish date for exactly this version (an unverifiable entry,
 * a registry error, a missing or unreadable date) is unknown, never old.
 */
export function buildAudit(
  lock: ParsedLockfile,
  meta: Map<string, FetchOutcome>,
  options: AuditOptions,
): AuditResult {
  const asOf = options.asOf ?? new Date();
  const threshold = options.minAgeDays * DAY_MS;
  const rows: AuditRow[] = [];
  const publishedMs = new Map<AuditRow, number>();

  for (const entry of selectEntries(lock, options)) {
    const row: AuditRow = {
      name: entry.name,
      version: entry.version,
      direct: entry.direct,
      dev: entry.dev,
      published: null,
      ageDays: null,
      provenance: null,
      deprecated: null,
      young: false,
    };
    rows.push(row);

    if (entry.unverifiable) {
      // The registry date would describe another artifact: do not look it up.
      row.error = entry.unverifiable;
      continue;
    }

    const outcome = meta.get(entry.name);
    const doc = outcome?.meta;
    if (!doc) {
      row.error = outcome?.error ?? 'no data';
      continue;
    }

    const versionMeta = own(doc.versions, entry.version);
    row.provenance = versionMeta?.provenance === true;
    row.deprecated = typeof versionMeta?.deprecated === 'string' ? versionMeta.deprecated : null;

    const rawTime: unknown = own(doc.time, entry.version);
    if (rawTime === undefined) {
      row.error = versionMeta
        ? 'registry lists this version without a publish date'
        : 'version not listed in registry';
      continue;
    }
    const ms = parseIsoTimestamp(rawTime);
    if (ms === null) {
      row.error =
        typeof rawTime === 'string'
          ? `unreadable publish date ${JSON.stringify(rawTime.slice(0, 40))}`
          : 'publish date is not a string';
      continue;
    }

    const delta = asOf.getTime() - ms;
    // Exact comparison in milliseconds; rounding is for display only. A
    // negative delta (dated after the reference date) is below any threshold:
    // the version did not exist yet, so it is young, on purpose.
    row.young = delta < threshold;
    row.published = new Date(ms).toISOString();
    row.ageDays = displayAge(delta, options.minAgeDays, row.young);
    publishedMs.set(row, ms);
  }

  // Youngest first — that is the list a reader acts on.
  rows.sort((a, b) => {
    const pa = publishedMs.get(a);
    const pb = publishedMs.get(b);
    if (pa === undefined && pb === undefined) return a.name.localeCompare(b.name);
    if (pa === undefined) return 1;
    if (pb === undefined) return -1;
    if (pa !== pb) return pb - pa;
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
