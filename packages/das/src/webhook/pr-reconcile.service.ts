import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Repository } from "typeorm";
import { PullRequest } from "../entities";
import { FETCH_QUEUE, FETCH_JOBS } from "../queue/constants";

// PR state (OPEN → MERGED/CLOSED) is written only by the pull_request webhook
// handler. A single missed/dropped `pull_request.closed` delivery therefore
// leaves a merged PR stuck OPEN forever, with no path to recover. This sweep
// closes that gap: on a schedule it re-enqueues a metadata fetch for every
// still-open PR in registered repos, and the metadata handler re-asserts
// authoritative GraphQL state — so missed merge events self-heal.
const RECONCILE_INTERVAL_MS = Number(
  process.env.PR_RECONCILE_INTERVAL_MS ?? 60 * 60 * 1000, // hourly
);
// Bound the sweep to the validator's scoring window — older PRs are no longer
// scored, so refreshing them buys nothing and only spends GitHub API budget.
const RECONCILE_WINDOW_DAYS = Number(
  process.env.PR_RECONCILE_WINDOW_DAYS ?? 45,
);

@Injectable()
export class PrReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrReconcileService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue,
  ) {}

  onModuleInit(): void {
    // Run once at startup, then on the interval.
    void this.reconcile();
    this.timer = setInterval(
      () => void this.reconcile(),
      RECONCILE_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async reconcile(): Promise<void> {
    try {
      const rows: { repo_full_name: string; pr_number: number }[] =
        await this.prRepo.query(
          `SELECT p.repo_full_name, p.pr_number
           FROM pull_requests p
           JOIN repos r ON r.repo_full_name = p.repo_full_name
           WHERE p.state = 'OPEN'
             AND r.registered = true
             AND p.created_at > NOW() - INTERVAL '${RECONCILE_WINDOW_DAYS} days'`,
        );

      this.logger.log(
        `Reconciling ${rows.length} open PRs against GitHub ` +
          `(window ${RECONCILE_WINDOW_DAYS}d)`,
      );

      for (const row of rows) {
        await this.fetchQueue.add(
          FETCH_JOBS.PR_METADATA,
          { repoFullName: row.repo_full_name, prNumber: row.pr_number },
          {
            // Same stable per-PR jobId as the webhook path — a reconcile job
            // dedupes against an already-pending webhook-triggered fetch.
            jobId: `meta-${row.repo_full_name}-${row.pr_number}`,
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
          },
        );
      }
    } catch (err) {
      this.logger.error(`Reconcile failed: ${String(err)}`);
    }
  }
}
