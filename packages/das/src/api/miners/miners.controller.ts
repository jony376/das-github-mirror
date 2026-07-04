import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { MinersService } from "./miners.service";
import { parsePaginationQuery } from "./pagination";

// GitHub owner/repo pattern: alphanum + `.`, `_`, `-`, reasonable length.
const REPO_FULL_NAME_PATTERN = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const MAX_REPO_ENTRIES = 200;

interface SinceByRepoBody {
  since_by_repo?: Record<string, unknown>;
}

/**
 * Validate a `{ since_by_repo: { "<owner/repo>": "<ISO timestamp>" } }` body
 * into parallel `repoNames` / `sinceValues` arrays. Repo names are lowercased
 * (for the case-insensitive JOIN) and timestamps normalized to ISO. Throws
 * BadRequestException on any malformed input.
 */
function parseSinceByRepo(body: SinceByRepoBody): {
  repoNames: string[];
  sinceValues: string[];
} {
  const map = body?.since_by_repo;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw new BadRequestException(
      "since_by_repo must be an object of { 'owner/repo': ISO timestamp }",
    );
  }
  const entries = Object.entries(map);
  if (entries.length === 0) {
    throw new BadRequestException("since_by_repo must have at least one entry");
  }
  if (entries.length > MAX_REPO_ENTRIES) {
    throw new BadRequestException(
      `since_by_repo must have at most ${MAX_REPO_ENTRIES} entries`,
    );
  }

  const repoNames: string[] = [];
  const sinceValues: string[] = [];
  const seen = new Set<string>();

  for (const [rawRepo, rawSince] of entries) {
    if (!REPO_FULL_NAME_PATTERN.test(rawRepo)) {
      throw new BadRequestException(
        `since_by_repo key "${rawRepo}" must match "owner/repo"`,
      );
    }
    const repo = rawRepo.toLowerCase();
    if (seen.has(repo)) {
      throw new BadRequestException(
        `since_by_repo has duplicate repo "${repo}" (keys collide after lowercasing)`,
      );
    }
    seen.add(repo);

    if (typeof rawSince !== "string") {
      throw new BadRequestException(
        `since_by_repo["${rawRepo}"] must be an ISO timestamp string`,
      );
    }
    const parsed = new Date(rawSince);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `since_by_repo["${rawRepo}"] is not a valid date: "${rawSince}"`,
      );
    }

    repoNames.push(repo);
    sinceValues.push(parsed.toISOString());
  }

  return { repoNames, sinceValues };
}

const SINCE_BY_REPO_API_BODY = {
  schema: {
    type: "object" as const,
    required: ["since_by_repo"],
    properties: {
      since_by_repo: {
        type: "object" as const,
        additionalProperties: { type: "string", format: "date-time" },
        example: { "entrius/gittensor": "2026-04-17T00:00:00Z" },
      },
    },
  },
};

@ApiTags("Miners")
@Controller("api/v1/miners")
export class MinersController {
  constructor(private readonly miners: MinersService) {}

  @Get(":githubId/pulls")
  @ApiOperation({
    summary: "Pull requests authored by a miner",
    description:
      "Returns every PR the miner has authored since the given date. Each " +
      "row includes full scoring inputs: review summary, current labels " +
      "(with actor attribution), linked issues (with their labels). File " +
      "contents are NOT included — fetch via /pulls/:o/:r/:n/files.",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID (numeric)" })
  @ApiQuery({
    name: "since",
    required: false,
    description:
      "ISO timestamp. Defaults to 35 days ago (midnight UTC) if omitted.",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    description:
      "Opaque pagination cursor from a previous response's next_cursor field.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Page size (default 50, max 200).",
  })
  async getPullRequests(
    @Param("githubId") githubId: string,
    @Query("since") since?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<unknown> {
    const pagination = parsePaginationQuery(limit, cursor);
    return this.miners.getPullRequests(
      githubId,
      MinersService.resolveSince(since),
      pagination,
    );
  }

  @Post(":githubId/pulls")
  @ApiOperation({
    summary: "Pull requests authored by a miner, windowed per repository",
    description:
      "Same response shape as GET /pulls, but each repository is filtered to " +
      "its own `since` from the request body instead of one shared window. " +
      "Only repositories named in the map are returned.",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID (numeric)" })
  @ApiBody(SINCE_BY_REPO_API_BODY)
  @ApiQuery({
    name: "cursor",
    required: false,
    description:
      "Opaque pagination cursor from a previous response's next_cursor field.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Page size (default 50, max 200).",
  })
  async postPullRequests(
    @Param("githubId") githubId: string,
    @Body() body: SinceByRepoBody,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<unknown> {
    const { repoNames, sinceValues } = parseSinceByRepo(body);
    const pagination = parsePaginationQuery(limit, cursor);
    return this.miners.getPullRequestsByRepo(
      githubId,
      repoNames,
      sinceValues,
      pagination,
    );
  }

  @Get(":githubId/issues")
  @ApiOperation({
    summary: "Issues authored by a miner",
    description:
      "Returns issues the miner has authored, with current labels (actor " +
      "attribution) and any solving PR. When `since` is provided, returns " +
      "OPEN issues created on/after that date plus CLOSED issues closed " +
      "on/after that date (scoring window). When `since` is omitted, " +
      "returns all currently-OPEN issues with no time bound and no CLOSED " +
      "history (open-issue load counting).",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID (numeric)" })
  @ApiQuery({
    name: "since",
    required: false,
    description:
      "ISO timestamp. When omitted, the response contains all currently-" +
      "OPEN issues with no time bound and no CLOSED history.",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    description:
      "Opaque pagination cursor from a previous response's next_cursor field.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Page size (default 50, max 200).",
  })
  async getIssues(
    @Param("githubId") githubId: string,
    @Query("since") since?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<unknown> {
    const pagination = parsePaginationQuery(limit, cursor);
    return this.miners.getIssues(githubId, since ?? null, pagination);
  }

  @Post(":githubId/issues")
  @ApiOperation({
    summary: "Issues authored by a miner, windowed per repository",
    description:
      "Same response shape as GET /issues with a `since`, but each " +
      "repository is filtered to its own `since` from the request body. " +
      "Only repositories named in the map are returned.",
  })
  @ApiParam({ name: "githubId", description: "GitHub user ID (numeric)" })
  @ApiBody(SINCE_BY_REPO_API_BODY)
  @ApiQuery({
    name: "cursor",
    required: false,
    description:
      "Opaque pagination cursor from a previous response's next_cursor field.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Page size (default 50, max 200).",
  })
  async postIssues(
    @Param("githubId") githubId: string,
    @Body() body: SinceByRepoBody,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<unknown> {
    const { repoNames, sinceValues } = parseSinceByRepo(body);
    const pagination = parsePaginationQuery(limit, cursor);
    return this.miners.getIssuesByRepo(
      githubId,
      repoNames,
      sinceValues,
      pagination,
    );
  }
}
