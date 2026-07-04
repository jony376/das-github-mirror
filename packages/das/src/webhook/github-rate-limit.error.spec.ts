import {
  GitHubRateLimitError,
  isGraphQLRateLimit,
} from "./github-rate-limit.error";

describe("isGraphQLRateLimit", () => {
  it("detects the primary RATE_LIMIT type", () => {
    expect(isGraphQLRateLimit([{ type: "RATE_LIMIT" }])).toBe(true);
  });

  it("detects SECONDARY_RATE_LIMIT", () => {
    expect(isGraphQLRateLimit([{ type: "SECONDARY_RATE_LIMIT" }])).toBe(true);
  });

  it("detects the RATE_LIMITED variant", () => {
    expect(isGraphQLRateLimit([{ type: "RATE_LIMITED" }])).toBe(true);
  });

  it("detects the graphql_rate_limit error code (real prod shape)", () => {
    expect(
      isGraphQLRateLimit([
        {
          type: "RATE_LIMIT",
          code: "graphql_rate_limit",
          message: "API rate limit already exceeded for installation ID 1.",
        },
      ]),
    ).toBe(true);
  });

  it("detects a rate-limit error mixed in with other errors", () => {
    expect(
      isGraphQLRateLimit([{ message: "field error" }, { type: "RATE_LIMIT" }]),
    ).toBe(true);
  });

  it("does not flag ordinary query errors (e.g. complexity)", () => {
    expect(isGraphQLRateLimit([{ type: "MAX_NODE_LIMIT_EXCEEDED" }])).toBe(
      false,
    );
    expect(isGraphQLRateLimit([{ message: "Field 'x' doesn't exist" }])).toBe(
      false,
    );
  });

  it("returns false for empty or non-array input", () => {
    expect(isGraphQLRateLimit([])).toBe(false);
    expect(isGraphQLRateLimit(undefined)).toBe(false);
    expect(isGraphQLRateLimit(null)).toBe(false);
    expect(isGraphQLRateLimit("RATE_LIMIT")).toBe(false);
  });
});

describe("GitHubRateLimitError", () => {
  it("carries the retry delay and is identifiable via instanceof", () => {
    const err = new GitHubRateLimitError("budget exhausted", 42_000);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect(err).toBeInstanceOf(Error);
    expect(err.retryAfterMs).toBe(42_000);
    expect(err.name).toBe("GitHubRateLimitError");
    expect(err.message).toBe("budget exhausted");
  });
});
