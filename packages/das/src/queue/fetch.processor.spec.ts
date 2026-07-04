import { Logger } from "@nestjs/common";
import { DelayedError, Job } from "bullmq";
import { FetchProcessor } from "./fetch.processor";
import { FETCH_JOBS } from "./constants";
import { GitHubRateLimitError } from "../webhook/github-rate-limit.error";

// Build a FetchProcessor with just enough mocked collaborators to drive the
// PR_METADATA path. fetchPrMetadata is the first GitHub call in that handler,
// so a rejection there exercises the process()-level error handling without the
// rest of the handler running.
function makeProcessor(fetchPrMetadata: jest.Mock): FetchProcessor {
  const fetcher = { fetchPrMetadata } as any;
  const prRepo = {} as any;
  const issueRepo = {} as any;
  const fetchQueue = {} as any;
  return new FetchProcessor(fetcher, prRepo, issueRepo, fetchQueue);
}

function metadataJob(): Job {
  return {
    name: FETCH_JOBS.PR_METADATA,
    id: "meta-acme/repo-1",
    data: { repoFullName: "acme/repo", prNumber: 1 },
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  } as unknown as Job;
}

describe("FetchProcessor rate-limit deferral", () => {
  beforeEach(() => {
    // Silence handler/deferral logging noise during the run.
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("defers the job (moveToDelayed + DelayedError) on a rate-limit error without failing it", async () => {
    const processor = makeProcessor(
      jest
        .fn()
        .mockRejectedValue(new GitHubRateLimitError("exhausted", 30_000)),
    );
    const job = metadataJob();
    const token = "lock-token";

    const before = Date.now();
    await expect(processor.process(job, token)).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [retryAt, passedToken] = (job.moveToDelayed as jest.Mock).mock
      .calls[0];
    // Deferred ~retryAfterMs into the future, and the lock token is forwarded
    // (moveToDelayed requires it to re-queue without consuming an attempt).
    expect(retryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(passedToken).toBe(token);
  });

  it("rethrows non-rate-limit errors unchanged and does NOT defer", async () => {
    const boom = new Error("genuine failure");
    const processor = makeProcessor(jest.fn().mockRejectedValue(boom));
    const job = metadataJob();

    await expect(processor.process(job, "tok")).rejects.toBe(boom);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
