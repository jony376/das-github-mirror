import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  UseGuards,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Repository } from "typeorm";
import { ApiTags, ApiOperation, ApiSecurity, ApiBody } from "@nestjs/swagger";
import { RequireApiKeyGuard } from "./require-api-key.guard";
import { Repo } from "../entities";
import { FETCH_QUEUE, FETCH_JOBS } from "../queue/constants";
import { validateRepoFullName } from "../utils/repo-full-name";

interface BackfillBody {
  repoFullName: string;
  days?: number;
}

interface RegisterBody {
  repoFullName: string;
}

function validateDays(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BadRequestException("days must be a positive number");
  }
  if (value > 365) {
    throw new BadRequestException("days must be <= 365");
  }
  return Math.floor(value);
}

@ApiTags("Admin")
@ApiSecurity("api-key")
@UseGuards(RequireApiKeyGuard)
@Controller("api/v1/admin")
export class AdminController {
  constructor(
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  @Post("backfill")
  @ApiOperation({
    summary: "Manually trigger a repo backfill",
    description:
      "Enqueues a backfill job that pages through PRs and issues " +
      "from the specified number of days. Defaults to 40 days.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["repoFullName"],
      properties: {
        repoFullName: { type: "string", example: "entrius/gittensor-ui" },
        days: { type: "number", example: 40, default: 40 },
      },
    },
  })
  async triggerBackfill(@Body() body: BackfillBody): Promise<{
    enqueued: boolean;
    repoFullName: string;
    days: number | undefined;
  }> {
    const repoFullName = validateRepoFullName(body?.repoFullName);
    const days = validateDays(body?.days);
    const canonicalRepoFullName =
      await this.resolveInstalledRepoFullName(repoFullName);

    await this.fetchQueue.add(
      FETCH_JOBS.BACKFILL_REPO,
      { repoFullName: canonicalRepoFullName, days },
      {
        jobId: `backfill-${canonicalRepoFullName}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );

    return { enqueued: true, repoFullName: canonicalRepoFullName, days };
  }

  @Post("repos/register")
  @ApiOperation({
    summary: "Flip a repo to registered and trigger default backfill",
    description:
      "Sets registered=true on an installed repo and enqueues a backfill " +
      "with the default time window. The repo must already be installed " +
      "(row created by the GitHub App installation webhook).",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["repoFullName"],
      properties: {
        repoFullName: { type: "string", example: "entrius/gittensor-ui" },
      },
    },
  })
  async registerRepo(@Body() body: RegisterBody): Promise<{
    repoFullName: string;
    registered: true;
    backfillEnqueued: boolean;
  }> {
    const repoFullName = validateRepoFullName(body?.repoFullName);

    const result = await this.repoRepo
      .createQueryBuilder()
      .update()
      .set({ registered: true })
      .where("LOWER(repo_full_name) = LOWER(:repoFullName)", { repoFullName })
      .execute();

    if (!result.affected) {
      throw new NotFoundException(
        `Repo ${repoFullName} not found — install the GitHub App first`,
      );
    }

    const canonicalRepoFullName =
      await this.resolveInstalledRepoFullName(repoFullName);

    await this.fetchQueue.add(
      FETCH_JOBS.BACKFILL_REPO,
      { repoFullName: canonicalRepoFullName },
      {
        jobId: `backfill-${canonicalRepoFullName}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );

    return {
      repoFullName: canonicalRepoFullName,
      registered: true,
      backfillEnqueued: true,
    };
  }

  /** Resolve the canonical repos PK after a case-insensitive match. */
  private async resolveInstalledRepoFullName(
    repoFullName: string,
  ): Promise<string> {
    const repo = await this.repoRepo
      .createQueryBuilder("repo")
      .select(["repo.repoFullName"])
      .where("LOWER(repo.repo_full_name) = LOWER(:repoFullName)", {
        repoFullName,
      })
      .getOne();

    if (!repo) {
      throw new NotFoundException(
        `Repo ${repoFullName} not found — install the GitHub App first`,
      );
    }

    return repo.repoFullName;
  }
}
