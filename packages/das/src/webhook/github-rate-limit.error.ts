/**
 * Thrown when GitHub reports a rate-limit hit. GraphQL signals this as an
 * HTTP 200 with `{errors:[{type:"RATE_LIMIT"|"SECONDARY_RATE_LIMIT", ...}]}`,
 * which is otherwise indistinguishable from a normal GraphQL error.
 *
 * The fetch queue processor catches this and defers the job via
 * `job.moveToDelayed(now + retryAfterMs)` + `DelayedError`, which re-queues the
 * job WITHOUT consuming a retry attempt and frees the worker slot to run other
 * jobs while the budget resets. `retryAfterMs` is derived from the response's
 * `retry-after` / `x-ratelimit-reset` headers.
 */
export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/**
 * True when a GraphQL `errors` array represents a rate-limit / secondary-limit
 * hit rather than a query error. GitHub returns these inside an HTTP 200 body,
 * so they must be detected by error `type`/`code`, not HTTP status. Matches the
 * documented `RATE_LIMIT` / `SECONDARY_RATE_LIMIT` types plus the
 * `graphql_rate_limit` error code seen in practice.
 */
export function isGraphQLRateLimit(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const err = e as { type?: unknown; code?: unknown } | null;
    return (
      err?.type === "RATE_LIMIT" ||
      err?.type === "SECONDARY_RATE_LIMIT" ||
      err?.type === "RATE_LIMITED" ||
      err?.code === "graphql_rate_limit"
    );
  });
}
