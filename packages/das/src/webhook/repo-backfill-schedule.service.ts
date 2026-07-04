import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Repository } from "typeorm";
import { Repo } from "../entities";
import {
  FETCH_QUEUE,
  FETCH_JOBS,
  DEFAULT_BACKFILL_DAYS,
} from "../queue/constants";

// Coarse safety net beneath the per-PR reconcile sweep: periodically re-backfill
// every registered repo from GitHub via GraphQL (authoritative state for PRs +
// issues + labels), catching any drift the targeted open-PR sweep doesn't —
// e.g. issue state, labels, or a PR that was already non-OPEN when last seen.
// Heavier than the reconcile sweep (re-touches every PR in the window), so it
// runs daily and can be disabled on critical infra via env.
const BACKFILL_ENABLED = process.env.NIGHTLY_BACKFILL_ENABLED !== "false";
// 12:10am America/Chicago. Anchored to the wall clock (not boot) so redeploys
// don't move the window; timeZone keeps it at local midnight across CST/CDT.
const BACKFILL_CRON = "10 0 * * *";
const BACKFILL_TZ = "America/Chicago";
const BACKFILL_DAYS = Number(
  process.env.NIGHTLY_BACKFILL_DAYS ?? DEFAULT_BACKFILL_DAYS,
);

@Injectable()
export class RepoBackfillScheduleService implements OnModuleInit {
  private readonly logger = new Logger(RepoBackfillScheduleService.name);

  constructor(
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue,
  ) {}

  onModuleInit(): void {
    if (!BACKFILL_ENABLED) {
      this.logger.log(
        "Nightly repo backfill disabled (NIGHTLY_BACKFILL_ENABLED=false)",
      );
      return;
    }
    this.logger.log(
      `Nightly repo backfill scheduled '${BACKFILL_CRON}' (${BACKFILL_TZ})`,
    );
  }

  // No run-at-startup (a deploy already implies fresh data, and this is heavy);
  // the static per-repo jobId dedupes a tick that overlaps a draining run.
  @Cron(BACKFILL_CRON, { name: "nightly-backfill", timeZone: BACKFILL_TZ })
  private async backfillAll(): Promise<void> {
    if (!BACKFILL_ENABLED) return;
    try {
      const repos = await this.repoRepo.find({
        where: { registered: true },
        select: { repoFullName: true },
      });

      this.logger.log(
        `Enqueuing nightly backfill for ${repos.length} repos ` +
          `(last ${BACKFILL_DAYS}d)`,
      );

      for (const repo of repos) {
        await this.fetchQueue.add(
          FETCH_JOBS.BACKFILL_REPO,
          { repoFullName: repo.repoFullName, days: BACKFILL_DAYS },
          {
            // Static per-repo jobId so a still-running nightly backfill isn't
            // stacked on by the next tick. Distinct from the admin endpoint's
            // timestamped ids, so manual backfills are never blocked.
            jobId: `backfill-${repo.repoFullName}-nightly`,
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 2,
            backoff: { type: "exponential", delay: 30000 },
          },
        );
      }
    } catch (err) {
      this.logger.error(`Nightly backfill enqueue failed: ${String(err)}`);
    }
  }
}
