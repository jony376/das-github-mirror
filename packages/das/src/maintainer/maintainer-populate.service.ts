import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Repo } from "../entities";
import {
  GitHubFetcherService,
  MaintainerRole,
} from "../webhook/github-fetcher.service";

interface MaintainerEntry {
  login: string | null;
  association: string;
}

@Injectable()
export class MaintainerPopulateService implements OnModuleInit {
  private readonly logger = new Logger(MaintainerPopulateService.name);

  constructor(
    private readonly fetcher: GitHubFetcherService,
    private readonly dataSource: DataSource,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  // Populate once on boot so a fresh deploy fills the maintainers table within
  // seconds — serve-time author/actor resolution and the label/review views all
  // read it. Fire-and-forget; the hourly @Cron keeps it fresh thereafter.
  onModuleInit(): void {
    void this.populate();
  }

  // author/reviewer association is snapshotted at ingest and never refreshed, so
  // a contributor who becomes (or stops being) a maintainer keeps a stale role
  // on every historical row. Rather than rewrite those stored snapshots, we keep
  // a live maintainers table (direct collaborators + org members) that the serve
  // path resolves against, for registered + installed repos only.
  @Cron(CronExpression.EVERY_HOUR)
  async populate(): Promise<void> {
    const repos: { repo_full_name: string }[] = await this.repoRepo.query(
      `SELECT repo_full_name FROM repos
       WHERE registered = true AND installation_id IS NOT NULL`,
    );
    this.logger.log(`Populating maintainers for ${repos.length} repos`);

    for (const { repo_full_name } of repos) {
      try {
        await this.populateRepo(repo_full_name);
      } catch (err) {
        // Fail closed per repo: a fetch/DB error skips this repo (never wipe a
        // repo's maintainers on partial data) and the next sweep retries it.
        this.logger.error(
          `Maintainer populate failed for ${repo_full_name}: ${String(err)}`,
        );
      }
    }
  }

  private async populateRepo(repoFullName: string): Promise<void> {
    // Fetch BOTH sets before any write — a partial fetch must never read as a
    // wipe. Hard failures throw and propagate to the per-repo catch above.
    const collaborators =
      await this.fetcher.fetchRepoCollaborators(repoFullName);
    const members = await this.fetcher.fetchOrgMembers(repoFullName);
    const current = this.buildRoleMap(repoFullName, collaborators, members);

    if (current.size === 0) {
      // A real repo always has at least its owner; an empty set means an
      // unexpected (but non-throwing) API response. Skip rather than wipe the
      // repo's maintainers.
      this.logger.warn(
        `${repoFullName}: empty maintainer set from GitHub, skipping`,
      );
      return;
    }

    const repoKey = repoFullName.toLowerCase();
    const ids = [...current.keys()];

    // Atomic per-repo refresh: upsert the live set, then drop anyone no longer
    // in it. Wrapped in a transaction so the table is never half-empty for this
    // repo mid-refresh (the serve path reads it concurrently).
    await this.dataSource.transaction(async (tx) => {
      for (const [githubId, entry] of current) {
        await tx.query(
          `INSERT INTO maintainers (repo_full_name, github_id, login, association, refreshed_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (repo_full_name, github_id)
           DO UPDATE SET login = EXCLUDED.login,
                         association = EXCLUDED.association,
                         refreshed_at = NOW()`,
          [repoKey, githubId, entry.login, entry.association],
        );
      }
      await tx.query(
        `DELETE FROM maintainers
         WHERE repo_full_name = $1 AND github_id <> ALL($2)`,
        [repoKey, ids],
      );
    });

    this.logger.log(`${repoFullName}: ${current.size} maintainers refreshed`);
  }

  // Precedence COLLABORATOR < MEMBER < OWNER: org members override direct
  // collaborators, and the repo owner (user-owned repos) outranks both.
  private buildRoleMap(
    repoFullName: string,
    collaborators: MaintainerRole[],
    members: MaintainerRole[],
  ): Map<string, MaintainerEntry> {
    const ownerLogin = repoFullName.split("/")[0].toLowerCase();
    const roles = new Map<string, MaintainerEntry>();
    for (const c of collaborators) {
      if (c.githubId)
        roles.set(c.githubId, {
          login: c.login ?? null,
          association: "COLLABORATOR",
        });
    }
    for (const m of members) {
      if (m.githubId)
        roles.set(m.githubId, {
          login: m.login ?? null,
          association: "MEMBER",
        });
    }
    for (const u of [...collaborators, ...members]) {
      if (u.githubId && u.login?.toLowerCase() === ownerLogin) {
        roles.set(u.githubId, { login: u.login ?? null, association: "OWNER" });
      }
    }
    return roles;
  }
}
