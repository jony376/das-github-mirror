// Pure change-detection predicates for the nightly incremental backfill. Both
// fail safe: any uncertainty (no stored row, null value) returns true so the
// job runs and we never skip a PR that's missing data.

export interface StoredPrState {
  headSha: string | null;
  baseSha: string | null;
  // Date from TypeORM (timestamptz), string in tests.
  updatedAt: Date | string | null;
  scoringDataStored: boolean;
}

// Content is determined by head+base SHA, so skip the PR_FILES fetch only when
// it's already stored and both SHAs are unchanged.
export function needsContentRefresh(
  stored: StoredPrState | null | undefined,
  headSha: string | null,
  baseSha: string | null,
): boolean {
  return !(
    stored?.scoringDataStored === true &&
    (stored.headSha ?? null) === headSha &&
    (stored.baseSha ?? null) === baseSha
  );
}

// Normalise a Date or ISO string to an epoch-ms instant; null if unparseable.
function toEpochMs(value: Date | string | null): number | null {
  if (value == null) return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Skip the PR_METADATA fetch only when GitHub's updatedAt instant is unchanged.
export function needsMetadataRefresh(
  stored: StoredPrState | null | undefined,
  updatedAt: string | null,
): boolean {
  const storedMs = stored ? toEpochMs(stored.updatedAt) : null;
  const incomingMs = toEpochMs(updatedAt);
  return !(storedMs != null && incomingMs != null && storedMs === incomingMs);
}
