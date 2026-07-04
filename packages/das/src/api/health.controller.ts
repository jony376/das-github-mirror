import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { DataSource, Not, IsNull, Repository } from "typeorm";
import { NoCache } from "../cache";
import { Repo } from "../entities";
import { FETCH_QUEUE } from "../queue/constants";

interface RepoHealth {
  repo_full_name: string;
  last_event_at: string | null;
  hours_ago: number | null;
}

interface HealthResponse {
  status: "ok" | "error";
  uptime_seconds: number;
  db: { ok: boolean; latency_ms: number | null };
  redis: {
    ok: boolean;
    queue_depth: number | null;
    active_jobs: number | null;
    failed_jobs: number | null;
  };
  repos: RepoHealth[];
}

@ApiTags("Health")
@Controller("api/v1/health")
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  @Get()
  @NoCache()
  @ApiOperation({
    summary: "Public health check",
    description:
      "Returns mirror health: DB and Redis reachability, queue state, " +
      "and the list of tracked repos with their last event timestamp. " +
      "Top-level status reflects DB+Redis only; repo staleness is informational.",
  })
  async getHealth(): Promise<HealthResponse> {
    const [db, redis, repos] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.listRepoHealth(),
    ]);

    const healthy = db.ok && redis.ok;
    const response: HealthResponse = {
      status: healthy ? "ok" : "error",
      uptime_seconds: Math.floor(process.uptime()),
      db,
      redis,
      repos,
    };

    // Return 503 (with the full body preserved) when core deps are down,
    // so LB/k8s/Cloudflare origin probes actually react.
    if (!healthy) {
      throw new HttpException(response, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return response;
  }

  private async checkDb(): Promise<{ ok: boolean; latency_ms: number | null }> {
    const started = Date.now();
    try {
      await this.dataSource.query("SELECT 1");
      return { ok: true, latency_ms: Date.now() - started };
    } catch {
      return { ok: false, latency_ms: null };
    }
  }

  private async checkRedis(): Promise<HealthResponse["redis"]> {
    try {
      const [wait, active, delayed, failed] = await Promise.all([
        this.fetchQueue.getWaitingCount(),
        this.fetchQueue.getActiveCount(),
        this.fetchQueue.getDelayedCount(),
        this.fetchQueue.getFailedCount(),
      ]);
      return {
        ok: true,
        queue_depth: wait + delayed,
        active_jobs: active,
        failed_jobs: failed,
      };
    } catch {
      return {
        ok: false,
        queue_depth: null,
        active_jobs: null,
        failed_jobs: null,
      };
    }
  }

  private async listRepoHealth(): Promise<RepoHealth[]> {
    // Soft-cleared rows (installationId=null after uninstall/remove) are kept
    // for historical scoring evidence but are no longer tracked. Installed but
    // unregistered repos are also excluded — webhook ingestion skips them.
    const repos = await this.repoRepo.find({
      where: { installationId: Not(IsNull()), registered: true },
      select: ["repoFullName", "lastEventAt"],
    });

    const now = Date.now();
    const rows: RepoHealth[] = repos.map((r) => {
      const lastEventAt = r.lastEventAt ?? null;
      const hoursAgo = lastEventAt
        ? (now - new Date(lastEventAt).getTime()) / 3_600_000
        : null;
      return {
        repo_full_name: r.repoFullName,
        last_event_at: lastEventAt,
        hours_ago: hoursAgo === null ? null : Math.round(hoursAgo * 10) / 10,
      };
    });

    // Stalest first; nulls last
    rows.sort((a, b) => {
      if (a.hours_ago === null) return 1;
      if (b.hours_ago === null) return -1;
      return b.hours_ago - a.hours_ago;
    });

    return rows;
  }
}
