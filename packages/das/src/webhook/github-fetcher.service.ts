/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { readFileSync } from "fs";
import { sign } from "jsonwebtoken";
import {
  Issue,
  LabelEvent,
  PrFile,
  PrFileContent,
  PullRequest,
  Repo,
  Review,
} from "../entities";
import {
  GitHubRateLimitError,
  isGraphQLRateLimit,
} from "./github-rate-limit.error";
import {
  needsContentRefresh,
  needsMetadataRefresh,
} from "./incremental-backfill";

interface InstallationToken {
  token: string;
  expiresAt: number;
}

interface ClosingIssueReference {
  number?: number;
  repository?: { nameWithOwner?: string } | null;
}

/**
 * A user's current maintainer role for a repo, sourced live from GitHub's
 * collaborators/members APIs. `association` mirrors GitHub's author_association
 * vocabulary so it can be written straight onto the stored activity rows.
 */
export interface MaintainerRole {
  githubId: string;
  login: string;
  association: "OWNER" | "MEMBER" | "COLLABORATOR";
}

// Files larger than this are stored with null content (AST parsing is wasteful past this).
const MAX_FILE_SIZE_BYTES = 1_000_000;

// Starting batch size for batched GraphQL file-content requests. Halves on failure.
const GRAPHQL_FILES_BATCH_SIZE = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class GitHubFetcherService implements OnModuleInit {
  private readonly logger = new Logger(GitHubFetcherService.name);
  private readonly appId: string;
  private privateKey: string;
  private readonly tokenCache = new Map<string, InstallationToken>();

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(PrFile)
    private readonly prFileRepo: Repository<PrFile>,
    @InjectRepository(PrFileContent)
    private readonly prFileContentRepo: Repository<PrFileContent>,
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
    @InjectRepository(Issue)
    private readonly issueRepo: Repository<Issue>,
    @InjectRepository(Review)
    private readonly reviewRepo: Repository<Review>,
    @InjectRepository(LabelEvent)
    private readonly labelEventRepo: Repository<LabelEvent>,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {
    this.appId = this.config.getOrThrow("GITHUB_APP_ID");
  }

  onModuleInit(): void {
    const keyPath = this.config.getOrThrow("GITHUB_PRIVATE_KEY_PATH");
    this.privateKey = readFileSync(keyPath, "utf8");
  }

  // --- Rate-limit-aware fetch ---

  /**
   * Wraps fetch() with GitHub rate-limit handling:
   * - Parses X-RateLimit-Remaining on every response; warns below 500.
   * - On 403/429 with remaining=0 or Retry-After header, waits until the
   *   rate limit resets and retries.
   * - On 5xx / network errors, retries with exponential backoff (max 3).
   */
  private async githubFetch(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (attempt < maxAttempts) {
          const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
          this.logger.warn(
            `Network error calling ${url}: ${err} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const remainingStr = res.headers.get("x-ratelimit-remaining");
      const remaining = remainingStr ? Number(remainingStr) : NaN;
      if (!isNaN(remaining) && remaining > 0 && remaining < 500) {
        this.logger.warn(`GitHub rate limit low: ${remaining} calls remaining`);
      }

      // Rate-limit exhausted → wait for reset and retry
      if (
        (res.status === 403 || res.status === 429) &&
        (remaining === 0 || res.headers.has("retry-after"))
      ) {
        const waitMs = this.computeRetryAfterMs(res);
        this.logger.warn(
          `Rate limit hit on ${url}: waiting ${Math.round(waitMs / 1000)}s before retry`,
        );
        await sleep(waitMs);
        continue;
      }

      // Server-side transient error — retry with backoff
      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts) {
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
        this.logger.warn(
          `GitHub ${res.status} on ${url} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      return res;
    }

    throw new Error(`githubFetch exhausted retries for ${url}`);
  }

  private computeRetryAfterMs(res: Response): number {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds)) return (seconds + 1) * 1000;
      const dateMs = Date.parse(retryAfter);
      if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now()) + 1000;
    }

    const reset = res.headers.get("x-ratelimit-reset");
    if (reset) {
      const resetMs = Number(reset) * 1000;
      if (!isNaN(resetMs)) return Math.max(0, resetMs - Date.now()) + 1000;
    }

    return 60_000;
  }

  private assertNoGraphQLErrors(
    body: any,
    context: string,
    res: Response,
  ): void {
    if (!body?.errors) return;

    // GraphQL rate limits arrive as HTTP 200 with the error in the body (unlike
    // REST's 403/429), so they bypass githubFetch's status-based handling.
    // Surface them as a typed error the queue processor can defer on, instead
    // of a generic throw that burns the job's retry attempts.
    if (isGraphQLRateLimit(body.errors)) {
      throw new GitHubRateLimitError(
        `${context} rate limited: ${JSON.stringify(body.errors)}`,
        this.computeRetryAfterMs(res),
      );
    }

    throw new Error(
      `${context} GraphQL errors: ${JSON.stringify(body.errors)}`,
    );
  }

  // --- Authentication ---

  private createAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      { iss: this.appId, iat: now - 60, exp: now + 600 },
      this.privateKey,
      { algorithm: "RS256" },
    );
  }

  private async getInstallationToken(installationId: string): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    const jwt = this.createAppJwt();
    const res = await this.githubFetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get installation token: ${res.status} ${await res.text()}`,
      );
    }

    const body = await res.json();
    this.tokenCache.set(installationId, {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime(),
    });

    return body.token;
  }

  private async getTokenForRepo(repoFullName: string): Promise<string> {
    const repo = await this.repoRepo
      .createQueryBuilder("repo")
      .where("LOWER(repo.repo_full_name) = LOWER(:repoFullName)", {
        repoFullName,
      })
      .getOne();
    if (!repo?.installationId) {
      throw new Error(`No installation for repo ${repoFullName}`);
    }
    return this.getInstallationToken(repo.installationId);
  }

  // --- REST: live maintainer roles (collaborators + org members) ---

  /**
   * Collaborators on the repo, returned as COLLABORATOR. The reconciler upgrades
   * org members to MEMBER and the repo owner to OWNER. We use affiliation=all (not
   * =direct) so access granted via a team or org base permission is included, not
   * just users explicitly added to the repo. This is deliberate: the live
   * maintainers table must reproduce GitHub's author_association (OWNER / MEMBER /
   * COLLABORATOR), which marks any org insider with repo access as a maintainer
   * regardless of how that access was granted. affiliation=direct missed
   * team/base-permission insiders, so org-owned repos whose members are private
   * (the GitHub default) resolved to an empty maintainer set and were skipped.
   */
  async fetchRepoCollaborators(
    repoFullName: string,
  ): Promise<MaintainerRole[]> {
    const token = await this.getTokenForRepo(repoFullName);
    const [owner, repo] = repoFullName.split("/");
    const users = await this.restGetAllPages(
      `https://api.github.com/repos/${owner}/${repo}/collaborators?affiliation=all&per_page=100`,
      token,
    );
    return users.map((u: any) => ({
      githubId: String(u.id),
      login: u.login,
      association: "COLLABORATOR" as const,
    }));
  }

  /**
   * Members of the owning org, returned as MEMBER. Resolves to [] when the
   * owner is a user account — /orgs/{user}/members 404s, which is correct: a
   * user-owned repo has only its owner and collaborators, no org members.
   */
  async fetchOrgMembers(repoFullName: string): Promise<MaintainerRole[]> {
    const token = await this.getTokenForRepo(repoFullName);
    const org = repoFullName.split("/")[0];
    const users = await this.restGetAllPages(
      `https://api.github.com/orgs/${org}/members?per_page=100`,
      token,
      { allow404: true },
    );
    return users.map((u: any) => ({
      githubId: String(u.id),
      login: u.login,
      association: "MEMBER" as const,
    }));
  }

  /**
   * GET every page of a paginated REST list endpoint, following the Link
   * header. Throws on any non-2xx (so callers fail closed) except a 404 when
   * `allow404` is set, which resolves to an empty list.
   */
  private async restGetAllPages(
    url: string,
    token: string,
    opts: { allow404?: boolean } = {},
  ): Promise<any[]> {
    const results: any[] = [];
    let next: string | null = url;

    while (next) {
      const res = await this.githubFetch(next, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.status === 404 && opts.allow404) return [];
      if (!res.ok) {
        throw new Error(
          `GitHub GET ${next} failed: ${res.status} ${await res.text()}`,
        );
      }
      const page = await res.json();
      if (Array.isArray(page)) results.push(...page);
      next = this.parseNextLink(res.headers.get("link"));
    }

    return results;
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(",")) {
      const match = part.match(/<([^>]+)>;\s*rel="next"/);
      if (match) return match[1];
    }
    return null;
  }

  // --- REST: compare API for merge-base ---

  /**
   * Fetch the merge-base commit SHA between two refs.
   * The merge-base is the common ancestor — the correct "before" state for
   * computing a PR's own changes via tree-diff scoring (which differs from
   * baseRefOid when the base branch has moved forward since PR open).
   */
  async fetchMergeBaseSha(
    repoFullName: string,
    baseSha: string,
    headSha: string,
  ): Promise<string | null> {
    const token = await this.getTokenForRepo(repoFullName);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.githubFetch(
          `https://api.github.com/repos/${repoFullName}/compare/${baseSha}...${headSha}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
          },
        );

        if (res.ok) {
          const data: any = await res.json();
          return data?.merge_base_commit?.sha ?? null;
        }

        if (attempt < maxAttempts) {
          const delay = Math.min(5000 * 2 ** (attempt - 1), 30_000);
          this.logger.warn(
            `Compare API for ${repoFullName} failed: ${res.status} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (err) {
        if (attempt < maxAttempts) {
          const delay = Math.min(5000 * 2 ** (attempt - 1), 30_000);
          this.logger.warn(
            `Compare API error for ${repoFullName}: ${err} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    this.logger.warn(
      `Compare API for ${repoFullName} failed after ${maxAttempts} attempts`,
    );
    return null;
  }

  // --- GraphQL: PR metadata (closing issues + body + last edit) ---

  /**
   * Fetch PR fields that require GraphQL — closing issue references,
   * body text, and the lastEditedAt timestamp (which is specific to body
   * edits, unlike REST's updated_at which changes on any interaction).
   * Combined into one query to save a round trip.
   */
  async fetchPrMetadata(
    repoFullName: string,
    prNumber: number,
  ): Promise<{
    closingIssueNumbers: number[];
    body: string | null;
    lastEditedAt: string | null;
    state: string;
    mergedAt: string | null;
    closedAt: string | null;
    mergedByLogin: string | null;
  }> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    // `state`/`mergedAt`/`closedAt`/`mergedBy` are returned alongside the body
    // so the metadata-fetch path can re-assert authoritative PR state — this is
    // what lets a missed `pull_request.closed` webhook self-heal (the webhook
    // handler is otherwise the only writer of state). GraphQL `state` is the
    // source of truth (OPEN / CLOSED / MERGED), unlike REST which reports a
    // merged PR as `closed` + `merged: true`.
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            bodyText
            lastEditedAt
            state
            mergedAt
            closedAt
            mergedBy { login }
            closingIssuesReferences(first: 10) {
              nodes {
                number
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    `;

    const res = await this.githubFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { owner, repo, pr: prNumber },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `GraphQL PR metadata fetch failed: ${res.status} ${await res.text()}`,
      );
    }

    const body: any = await res.json();
    this.assertNoGraphQLErrors(body, "PR metadata fetch", res);

    const pr = body.data?.repository?.pullRequest;
    if (!pr) {
      throw new Error(`GraphQL PR metadata fetch returned no PR data`);
    }

    const nodes = pr.closingIssuesReferences?.nodes ?? [];

    return {
      closingIssueNumbers: this.sameRepoClosingIssueNumbers(
        repoFullName,
        nodes,
      ),
      body: pr.bodyText ?? null,
      lastEditedAt: pr.lastEditedAt ?? null,
      state: pr.state,
      mergedAt: pr.mergedAt ?? null,
      closedAt: pr.closedAt ?? null,
      mergedByLogin: pr.mergedBy?.login ?? null,
    };
  }

  private sameRepoClosingIssueNumbers(
    repoFullName: string,
    nodes: ClosingIssueReference[],
  ): number[] {
    const expectedRepo = repoFullName.toLowerCase();
    return nodes
      .filter(
        (node) =>
          node.repository?.nameWithOwner?.toLowerCase() === expectedRepo,
      )
      .map((node) => node.number)
      .filter((number): number is number => typeof number === "number");
  }

  // --- GraphQL: issue closure (which PR caused the current close) ---

  /**
   * Resolve the PR responsible for an issue's current closed state.
   *
   * Reads `ClosedEvent.closer` from the issue timeline and anchors to the
   * issue's most-recent close (GitHub freezes `closedAt` at the *first* close,
   * so the latest `ClosedEvent` is used as the effective close), so reopen-
   * then-reclose cycles attribute to the latest closer, not whichever PR first
   * declared `Closes #N` in its body. When no PR closer is recorded — e.g. the issue was closed manually
   * rather than auto-closed by the merge — falls back to the issue's
   * closing-PR references (a merged same-repo PR). Returns `null` for non-PR
   * closures (commits, projects), `NOT_PLANNED` closures, or when neither
   * source yields a qualifying merged same-repo PR.
   *
   * Source of truth for `issues.solved_by_pr`. Issue discovery and the
   * issue-bounty solver lookup both read from this field, so they stay 1:1.
   */
  async fetchIssueClosingPr(
    repoFullName: string,
    issueNumber: number,
  ): Promise<number | null> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const query = `
      query($owner: String!, $repo: String!, $issue: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issue) {
            closedAt
            stateReason
            timelineItems(itemTypes: [CLOSED_EVENT], last: 20) {
              nodes {
                ... on ClosedEvent {
                  createdAt
                  stateReason
                  closer {
                    __typename
                    ... on PullRequest {
                      number
                      merged
                      state
                      baseRepository { nameWithOwner }
                    }
                  }
                }
              }
            }
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
              nodes {
                number
                merged
                mergedAt
                baseRepository { nameWithOwner }
              }
            }
          }
        }
      }
    `;

    const res = await this.githubFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { owner, repo, issue: issueNumber },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `GraphQL issue closure fetch failed: ${res.status} ${await res.text()}`,
      );
    }

    const body: any = await res.json();
    this.assertNoGraphQLErrors(body, "Issue closure fetch", res);

    const issue = body.data?.repository?.issue;
    if (!issue) return null;

    return this.selectClosingPr(repoFullName, issue);
  }

  private selectClosingPrFromTimeline(
    repoFullName: string,
    issue: {
      closedAt: string | null;
      timelineItems?: { nodes?: any[] };
    },
    effectiveClosedAt: string | null,
  ): number | null {
    if (!effectiveClosedAt) return null;

    const expectedRepo = repoFullName.toLowerCase();
    const nodes = issue.timelineItems?.nodes ?? [];

    // Walk newest to oldest, find the close event matching the issue's
    // current (most-recent) close. NOT_PLANNED closures (and anything else
    // non-COMPLETED) don't attribute a solver.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const ev = nodes[i];
      if (!ev) continue;
      const stateReason = ev.stateReason;
      if (
        stateReason != null &&
        String(stateReason).toUpperCase() !== "COMPLETED"
      ) {
        continue;
      }
      if (ev.createdAt !== effectiveClosedAt) continue;
      const closer = ev.closer;
      if (!closer || closer.__typename !== "PullRequest") return null;
      if (
        (closer.baseRepository?.nameWithOwner ?? "").toLowerCase() !==
        expectedRepo
      ) {
        return null;
      }
      const merged =
        closer.merged === true ||
        String(closer.state ?? "").toUpperCase() === "MERGED";
      if (!merged) return null;
      return typeof closer.number === "number" ? closer.number : null;
    }
    return null;
  }

  /**
   * GitHub freezes `issue.closedAt` at the first time the issue entered the
   * closed state and does not advance it on a re-close, so it is unreliable as
   * the "current close" anchor for a reopened issue. The current close is the
   * most-recent CLOSED_EVENT in the timeline; use its `createdAt`. Falls back to
   * `issue.closedAt` only when the timeline carries no CLOSED_EVENT.
   */
  private effectiveClosedAt(issue: {
    closedAt: string | null;
    timelineItems?: { nodes?: any[] };
  }): string | null {
    const nodes = issue.timelineItems?.nodes ?? [];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const createdAt = nodes[i]?.createdAt;
      if (createdAt) return createdAt;
    }
    return issue.closedAt;
  }

  /**
   * Resolve an issue's solving PR: prefer the authoritative
   * `ClosedEvent.closer`, then fall back to the issue's closing-PR references.
   * Shared by the webhook closure path and the backfill so both write
   * `issues.solved_by_pr` identically.
   */
  private selectClosingPr(
    repoFullName: string,
    issue: {
      closedAt: string | null;
      stateReason?: string | null;
      timelineItems?: { nodes?: any[] };
      closedByPullRequestsReferences?: { nodes?: any[] };
    },
  ): number | null {
    const effectiveClosedAt = this.effectiveClosedAt(issue);
    const viaCloser = this.selectClosingPrFromTimeline(
      repoFullName,
      issue,
      effectiveClosedAt,
    );
    if (viaCloser != null) return viaCloser;
    return this.selectClosingPrFromClosingRefs(
      repoFullName,
      issue,
      effectiveClosedAt,
    );
  }

  /**
   * Fallback attribution from `closedByPullRequestsReferences` for issues that
   * were closed without GitHub recording a PR closer (manual close, or a
   * `Closes #N` keyword added after the PR merged). Gated to a COMPLETED
   * closure and a merged same-repo PR that merged at or before the close —
   * downstream gates (token threshold, one-issue-per-PR, author ≠ solver,
   * branch eligibility) still apply on the consumer side.
   */
  private selectClosingPrFromClosingRefs(
    repoFullName: string,
    issue: {
      closedAt: string | null;
      stateReason?: string | null;
      closedByPullRequestsReferences?: { nodes?: any[] };
    },
    effectiveClosedAt: string | null,
  ): number | null {
    // Only COMPLETED closures attribute a solver — parity with the closer path.
    if (
      issue.stateReason != null &&
      String(issue.stateReason).toUpperCase() !== "COMPLETED"
    ) {
      return null;
    }

    const closedAt = effectiveClosedAt ? Date.parse(effectiveClosedAt) : null;
    const expectedRepo = repoFullName.toLowerCase();

    const candidates = (issue.closedByPullRequestsReferences?.nodes ?? [])
      .filter((n: any) => n?.merged === true)
      .filter(
        (n: any) =>
          (n.baseRepository?.nameWithOwner ?? "").toLowerCase() ===
          expectedRepo,
      )
      .filter((n: any) => {
        // A PR can't have caused a close that predates its merge.
        if (closedAt == null || !n.mergedAt) return true;
        return Date.parse(n.mergedAt) <= closedAt;
      });

    if (candidates.length === 0) return null;

    // Deterministic pick: latest merge on/before the close (closest cause),
    // tie-broken by highest PR number.
    candidates.sort(
      (a: any, b: any) =>
        (Date.parse(b.mergedAt ?? "") || 0) -
          (Date.parse(a.mergedAt ?? "") || 0) || b.number - a.number,
    );
    return candidates[0].number;
  }

  // --- PR files + contents (REST for list, batched GraphQL for contents) ---

  /**
   * Fetch the PR's file list (REST) and all file contents (batched GraphQL).
   * GraphQL's object(expression: "SHA:path") returns content directly from git
   * blobs, so it works even when fork branches are deleted post-merge. Files
   * are fetched in batches of 50 to avoid GraphQL complexity limits; on
   * failure the batch size halves down to a floor of 5.
   */
  async fetchAndStorePrFiles(
    repoFullName: string,
    prNumber: number,
  ): Promise<void> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const pr = await this.prRepo.findOneBy({ repoFullName, prNumber });
    if (!pr) {
      throw new Error(`PR ${repoFullName}#${prNumber} not found in DB`);
    }

    // Fetch and store the merge-base SHA. Needed for correct tree-diff
    // scoring — differs from baseSha when base branch has advanced. Recompute
    // on every fetch: a stored value can go stale when head advances via
    // synchronize, leaving base_content pinned to an old ancestor and
    // inflating the scored diff with churn from unrelated PRs.
    if (pr.baseSha && pr.headSha) {
      const mergeBaseSha = await this.fetchMergeBaseSha(
        repoFullName,
        pr.baseSha,
        pr.headSha,
      );
      if (mergeBaseSha) {
        await this.prRepo.update({ repoFullName, prNumber }, { mergeBaseSha });
        pr.mergeBaseSha = mergeBaseSha;
      }
    }

    // 1. Fetch file list via REST
    const files = await this.fetchAllPrFiles(owner, repo, prNumber, token);

    // Clear any stale data for this PR (e.g. after a synchronize event)
    await this.prFileRepo.delete({ repoFullName, prNumber });
    await this.prFileContentRepo.delete({ repoFullName, prNumber });

    // 2. Upsert file metadata
    for (const file of files) {
      await this.prFileRepo.upsert(
        {
          repoFullName,
          prNumber,
          filename: file.filename,
          previousFilename: file.previous_filename ?? null,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
        },
        ["repoFullName", "prNumber", "filename"],
      );
    }

    // 3. Fetch file contents in batches (base + head in one GraphQL call each)
    if (!pr.headSha) {
      throw new Error(
        `PR ${repoFullName}#${prNumber} has no head SHA; cannot fetch content`,
      );
    }

    // Prefer merge-base SHA (true common ancestor) over base SHA for
    // fetching the "before" version of files. Falls back to base SHA if
    // merge-base couldn't be resolved.
    const baseForContents = pr.mergeBaseSha ?? pr.baseSha;

    await this.fetchAndStoreBatchedContents(
      repoFullName,
      prNumber,
      files,
      owner,
      repo,
      token,
      pr.headSha,
      baseForContents,
    );
  }

  private async fetchAllPrFiles(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<any[]> {
    const maxAttempts = 3;
    let perPage = 100;
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        const files: any[] = [];
        let page = 1;

        while (true) {
          const res = await this.githubFetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
              },
            },
          );

          // Halve page size on server-side errors (large payload)
          if ([502, 503, 504].includes(res.status)) {
            perPage = Math.max(Math.floor(perPage / 2), 10);
            throw new Error(
              `status ${res.status}, retrying with per_page=${perPage}`,
            );
          }

          if (!res.ok) {
            throw new Error(
              `Failed to fetch PR files: ${res.status} ${await res.text()}`,
            );
          }

          const batch = await res.json();
          files.push(...batch);

          if (batch.length < perPage) return files;
          page++;
        }
      } catch (err) {
        attempt++;
        if (attempt >= maxAttempts) throw err;
        const delay = Math.min(5000 * 2 ** (attempt - 1), 30_000);
        this.logger.warn(
          `PR files fetch failed (attempt ${attempt}/${maxAttempts}): ${err}. Retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    return [];
  }

  /**
   * Batched GraphQL fetch of base + head contents for all files in the PR.
   * On complexity/size errors, batch size halves (50 → 25 → 12 → 6 → 5 floor).
   */
  private async fetchAndStoreBatchedContents(
    repoFullName: string,
    prNumber: number,
    files: any[],
    owner: string,
    repo: string,
    token: string,
    headSha: string,
    baseSha: string | null,
  ): Promise<void> {
    // Added files have only a head blob; removed files have only a base blob.
    // Keep removed files when a base SHA is available so deletion scoring has
    // the content that existed before the PR.
    const contentFiles = files.filter(
      (f) => f.status !== "removed" || baseSha !== null,
    );
    if (contentFiles.length === 0) return;

    let batchSize = GRAPHQL_FILES_BATCH_SIZE;
    const minBatchSize = 5;

    for (let i = 0; i < contentFiles.length; ) {
      const batch = contentFiles.slice(i, i + batchSize);
      try {
        await this.fetchContentBatch(
          repoFullName,
          prNumber,
          batch,
          owner,
          repo,
          token,
          headSha,
          baseSha,
        );
        i += batch.length;
      } catch (err) {
        // A rate limit isn't a too-big-batch problem — halving just spams more
        // doomed requests at an exhausted budget. Let it propagate so the queue
        // processor defers the whole job until the budget resets.
        if (err instanceof GitHubRateLimitError) throw err;
        if (batchSize > minBatchSize) {
          const newSize = Math.max(Math.floor(batchSize / 2), minBatchSize);
          this.logger.warn(
            `GraphQL content batch failed (size=${batchSize}): ${err}. Halving to ${newSize}`,
          );
          batchSize = newSize;
          // Retry same i with smaller batch
        } else {
          throw new Error(
            `GraphQL content batch failed at min size ${minBatchSize}: ${err}`,
          );
        }
      }
    }
  }

  private async fetchContentBatch(
    repoFullName: string,
    prNumber: number,
    batch: any[],
    owner: string,
    repo: string,
    token: string,
    headSha: string,
    baseSha: string | null,
  ): Promise<void> {
    const fields: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];
      // Base version — skip for added files or if we have no base SHA
      if (file.status !== "added" && baseSha) {
        const basePath = file.previous_filename ?? file.filename;
        const baseExpr = this.escapeGraphql(`${baseSha}:${basePath}`);
        fields.push(
          `base${i}: object(expression: "${baseExpr}") { ... on Blob { text byteSize isBinary } }`,
        );
      }
      // Removed files do not exist at head; store a null headContent while
      // still fetching the base blob above.
      if (file.status !== "removed") {
        const headExpr = this.escapeGraphql(`${headSha}:${file.filename}`);
        fields.push(
          `head${i}: object(expression: "${headExpr}") { ... on Blob { text byteSize isBinary } }`,
        );
      }
    }

    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          ${fields.join("\n          ")}
        }
      }
    `;

    const res = await this.githubFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { owner, repo },
      }),
    });

    if (!res.ok) {
      throw new Error(
        `GraphQL content fetch failed: ${res.status} ${await res.text()}`,
      );
    }

    const body: any = await res.json();
    this.assertNoGraphQLErrors(body, "Content fetch", res);

    const repoData = body.data?.repository ?? {};

    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];

      const baseBlob = repoData[`base${i}`];
      const headBlob = repoData[`head${i}`];

      const isBinary = !!headBlob?.isBinary || !!baseBlob?.isBinary;

      const headContent = this.extractBlobText(headBlob);
      const baseContent = this.extractBlobText(baseBlob);
      const byteSize = headBlob?.byteSize ?? baseBlob?.byteSize ?? null;

      await this.prFileContentRepo.upsert(
        {
          repoFullName,
          prNumber,
          filename: file.filename,
          baseContent,
          headContent,
          isBinary,
          byteSize,
        },
        ["repoFullName", "prNumber", "filename"],
      );
    }
  }

  private extractBlobText(blob: any): string | null {
    if (!blob) return null;
    if (blob.isBinary) return null;
    if (
      typeof blob.byteSize === "number" &&
      blob.byteSize > MAX_FILE_SIZE_BYTES
    ) {
      return null;
    }
    return blob.text ?? null;
  }

  private escapeGraphql(s: string): string {
    // GraphQL string literals follow the same escape rules as JSON strings —
    // reuse the JSON encoder, stripping the surrounding quotes. Covers
    // backslash, double-quote, newlines, tabs, and control characters.
    const json = JSON.stringify(s);
    return json.slice(1, -1);
  }

  // --- Backfill ---

  /**
   * Page through GraphQL for PRs in a repo created within the last N days.
   * Upserts each PR. Returns the list of PR numbers so the caller can
   * enqueue follow-up fetch jobs for diffs + closing issues.
   *
   * The backfill is a safety net behind real-time webhook ingestion, so for
   * each PR we compare the freshly-fetched values against the PRE-upsert stored
   * row and return per-PR gating flags so the caller re-fetches only what
   * actually changed (see #incremental-backfill):
   *   - needsFilesJob:    the PR_FILES content fetch (REST file list + merge-base
   *     + batched GraphQL content) is fully determined by head+base SHA. Skip it
   *     only when the stored row already has its content (scoringDataStored) AND
   *     both SHAs are unchanged.
   *   - needsMetadataJob: the PR_METADATA fetch (closing-issue links, body, state,
   *     merged/closed timestamps) is gated on GitHub's pull request updatedAt,
   *     which bumps on edits, state changes, merges, closes and link changes.
   * Both flags fail safe toward re-fetching: a new PR, a missing stored value,
   * or any uncertainty forces the job to be enqueued.
   */
  async backfillPullRequests(
    repoFullName: string,
    sinceDate: Date,
  ): Promise<
    {
      prNumber: number;
      headSha: string | null;
      baseSha: string | null;
      needsFilesJob: boolean;
      needsMetadataJob: boolean;
    }[]
  > {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          defaultBranchRef { name }
          pullRequests(
            first: 50,
            after: $cursor,
            orderBy: {field: CREATED_AT, direction: DESC}
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              bodyText
              state
              createdAt
              closedAt
              mergedAt
              updatedAt
              lastEditedAt
              merged
              author {
                login
                ... on User { databaseId }
                ... on Bot { databaseId }
              }
              authorAssociation
              mergedBy { login }
              baseRef { name }
              headRef { name }
              headRepository { nameWithOwner }
              baseRefOid
              headRefOid
              additions
              deletions
              commits { totalCount }
              labels(first: 10) { nodes { name } }
              reviews(first: 10) {
                nodes {
                  submittedAt
                  state
                  authorAssociation
                  author {
                    login
                    ... on User { databaseId }
                    ... on Bot { databaseId }
                  }
                }
              }
              timelineItems(
                itemTypes: [LABELED_EVENT, UNLABELED_EVENT]
                first: 30
              ) {
                nodes {
                  __typename
                  ... on LabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                  ... on UnlabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const prs: {
      prNumber: number;
      headSha: string | null;
      baseSha: string | null;
      needsFilesJob: boolean;
      needsMetadataJob: boolean;
    }[] = [];
    let cursor: string | null = null;
    let defaultBranchWritten = false;

    while (true) {
      const res: Response = await this.githubFetch(
        "https://api.github.com/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            variables: { owner, repo, cursor },
          }),
        },
      );

      if (!res.ok) {
        throw new Error(
          `Backfill PR GraphQL failed: ${res.status} ${await res.text()}`,
        );
      }

      const body: any = await res.json();
      this.assertNoGraphQLErrors(body, "Backfill PR fetch", res);

      const repoData: any = body.data?.repository;
      const page: any = repoData?.pullRequests;
      if (!page) {
        throw new Error(`Backfill PR GraphQL returned no pullRequests page`);
      }

      // defaultBranchRef is the same across every page — write once.
      if (!defaultBranchWritten) {
        const defaultBranch: string | null =
          repoData?.defaultBranchRef?.name ?? null;
        if (defaultBranch) {
          await this.repoRepo.update(repoFullName, { defaultBranch });
        }
        defaultBranchWritten = true;
      }

      let shouldStop = false;
      for (const pr of page.nodes) {
        // Ordered DESC by created_at — stop once we cross the cutoff
        if (new Date(pr.createdAt) < sinceDate) {
          shouldStop = true;
          break;
        }

        const headSha: string | null = pr.headRefOid ?? null;
        const baseSha: string | null = pr.baseRefOid ?? null;
        const updatedAt: string | null = pr.updatedAt ?? null;

        // Capture the PRE-upsert stored row: the upsert below overwrites it, so
        // the change-detection must read the old values first. A missing row
        // (new PR) leaves `existing` undefined and forces both jobs.
        const existing = await this.prRepo.findOne({
          where: { repoFullName, prNumber: pr.number },
          select: {
            headSha: true,
            baseSha: true,
            updatedAt: true,
            scoringDataStored: true,
          },
        });

        const needsFilesJob = needsContentRefresh(existing, headSha, baseSha);
        const needsMetadataJob = needsMetadataRefresh(existing, updatedAt);

        await this.prRepo.upsert(
          {
            repoFullName,
            prNumber: pr.number,
            authorGithubId: String(pr.author?.databaseId ?? ""),
            authorLogin: pr.author?.login ?? null,
            authorAssociation: pr.authorAssociation ?? null,
            title: pr.title,
            body: pr.bodyText ?? null,
            state: pr.state, // OPEN / CLOSED / MERGED
            createdAt: pr.createdAt,
            closedAt: pr.closedAt ?? null,
            mergedAt: pr.mergedAt ?? null,
            updatedAt,
            lastEditedAt: pr.lastEditedAt ?? null,
            mergedByLogin: pr.mergedBy?.login ?? null,
            baseRef: pr.baseRef?.name ?? null,
            headRef: pr.headRef?.name ?? null,
            headRepoFullName: pr.headRepository?.nameWithOwner ?? null,
            // head/base SHA columns are nullable in the DB but typed non-null
            // on the entity; null is a valid stored value (e.g. deleted head).
            headSha: headSha as string,
            baseSha: baseSha as string,
            additions: pr.additions ?? null,
            deletions: pr.deletions ?? null,
            commitsCount: pr.commits?.totalCount ?? null,
            labels: (pr.labels?.nodes ?? []).map(
              (l: { name: string }) => l.name,
            ),
          },
          ["repoFullName", "prNumber"],
        );

        // Upsert reviews captured in the same query
        const reviewNodes = pr.reviews?.nodes ?? [];
        for (const review of reviewNodes) {
          if (!review?.submittedAt || !review?.author?.databaseId) continue;
          await this.reviewRepo.upsert(
            {
              repoFullName,
              prNumber: pr.number,
              reviewerGithubId: String(review.author.databaseId),
              reviewerLogin: review.author.login ?? null,
              reviewerAssociation: review.authorAssociation ?? null,
              reviewState: review.state,
              submittedAt: review.submittedAt,
            },
            ["repoFullName", "prNumber", "reviewerGithubId", "submittedAt"],
          );
        }

        // Upsert label events (LABELED_EVENT / UNLABELED_EVENT)
        await this.saveLabelTimelineEvents(
          repoFullName,
          pr.number,
          "pr",
          pr.timelineItems?.nodes ?? [],
        );

        prs.push({
          prNumber: pr.number,
          headSha,
          baseSha,
          needsFilesJob,
          needsMetadataJob,
        });
      }

      if (shouldStop || !page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return prs;
  }

  /**
   * Page through GraphQL for issues in a repo created within the last N days.
   * Upserts each issue. Returns the number of issues processed (for the
   * backfill summary log).
   */
  async backfillIssues(repoFullName: string, sinceDate: Date): Promise<number> {
    const [owner, repo] = repoFullName.split("/");
    const token = await this.getTokenForRepo(repoFullName);

    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          issues(
            first: 50,
            after: $cursor,
            orderBy: {field: CREATED_AT, direction: DESC}
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              state
              stateReason
              createdAt
              closedAt
              updatedAt
              lastEditedAt
              author {
                login
                ... on User { databaseId }
                ... on Bot { databaseId }
              }
              authorAssociation
              labels(first: 10) { nodes { name } }
              timelineItems(
                itemTypes: [LABELED_EVENT, UNLABELED_EVENT, TRANSFERRED_EVENT]
                first: 30
              ) {
                nodes {
                  __typename
                  ... on TransferredEvent {
                    createdAt
                  }
                  ... on LabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                  ... on UnlabeledEvent {
                    createdAt
                    label { name }
                    actor {
                      login
                      ... on User { databaseId }
                    }
                  }
                }
              }
              closureTimeline: timelineItems(
                itemTypes: [CLOSED_EVENT]
                last: 20
              ) {
                nodes {
                  ... on ClosedEvent {
                    createdAt
                    stateReason
                    closer {
                      __typename
                      ... on PullRequest {
                        number
                        merged
                        state
                        baseRepository { nameWithOwner }
                      }
                    }
                  }
                }
              }
              closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
                nodes {
                  number
                  merged
                  mergedAt
                  baseRepository { nameWithOwner }
                }
              }
            }
          }
        }
      }
    `;

    let cursor: string | null = null;
    let issueCount = 0;

    while (true) {
      const res: Response = await this.githubFetch(
        "https://api.github.com/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            variables: { owner, repo, cursor },
          }),
        },
      );

      if (!res.ok) {
        throw new Error(
          `Backfill issue GraphQL failed: ${res.status} ${await res.text()}`,
        );
      }

      const body: any = await res.json();
      this.assertNoGraphQLErrors(body, "Backfill issue fetch", res);

      const page: any = body.data?.repository?.issues;
      if (!page) {
        throw new Error(`Backfill issue GraphQL returned no issues page`);
      }

      let shouldStop = false;
      for (const issue of page.nodes) {
        if (new Date(issue.createdAt) < sinceDate) {
          shouldStop = true;
          break;
        }

        const issueData: Partial<Issue> = {
          repoFullName,
          issueNumber: issue.number,
          authorGithubId: String(issue.author?.databaseId ?? ""),
          authorLogin: issue.author?.login ?? null,
          authorAssociation: issue.authorAssociation ?? null,
          title: issue.title,
          state: issue.state, // OPEN / CLOSED
          stateReason: issue.stateReason ?? null,
          createdAt: issue.createdAt,
          closedAt: issue.closedAt ?? null,
          updatedAt: issue.updatedAt ?? null,
          lastEditedAt: issue.lastEditedAt ?? null,
          labels: (issue.labels?.nodes ?? []).map(
            (l: { name: string }) => l.name,
          ),
        };

        if (
          (issue.timelineItems?.nodes ?? []).some(
            (node: { __typename?: string }) =>
              node.__typename === "TransferredEvent",
          )
        ) {
          issueData.isTransferred = true;
        }

        issueData.solvedByPr =
          issue.state === "CLOSED"
            ? this.selectClosingPr(repoFullName, {
                closedAt: issue.closedAt ?? null,
                stateReason: issue.stateReason ?? null,
                timelineItems: { nodes: issue.closureTimeline?.nodes ?? [] },
                closedByPullRequestsReferences: {
                  nodes: issue.closedByPullRequestsReferences?.nodes ?? [],
                },
              })
            : null;

        await this.issueRepo.upsert(issueData, ["repoFullName", "issueNumber"]);

        // Upsert label events for this issue
        await this.saveLabelTimelineEvents(
          repoFullName,
          issue.number,
          "issue",
          issue.timelineItems?.nodes ?? [],
        );

        issueCount += 1;
      }

      if (shouldStop || !page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return issueCount;
  }

  /**
   * Insert LABELED_EVENT / UNLABELED_EVENT timeline nodes into label_events.
   * Idempotent: relies on the uq_label_events_natural_key UNIQUE index so
   * re-running backfill (or BullMQ retries) collapses to a no-op for events
   * already written. Actor role is resolved at read time against the live
   * maintainers table (see pr_labels_by_actor view); GraphQL's actor type
   * doesn't expose authorAssociation.
   */
  private async saveLabelTimelineEvents(
    repoFullName: string,
    targetNumber: number,
    targetType: "pr" | "issue",
    nodes: any[],
  ): Promise<void> {
    const rows = nodes
      .filter((node) => node && node.label?.name && node.createdAt)
      .map((node) => ({
        repoFullName,
        targetNumber,
        targetType,
        labelName: node.label.name,
        action: node.__typename === "LabeledEvent" ? "labeled" : "unlabeled",
        actorGithubId: node.actor?.databaseId
          ? String(node.actor.databaseId)
          : null,
        actorLogin: node.actor?.login ?? null,
        timestamp: node.createdAt,
      }));

    if (rows.length === 0) return;

    await this.labelEventRepo
      .createQueryBuilder()
      .insert()
      .values(rows)
      .orIgnore()
      .execute();
  }
}
