/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LabelEvent, Issue, PullRequest } from "../../entities";

type RepoLabelTargetType = "pr" | "issue";

type CurrentRepoLabelTarget = {
  repoFullName: string;
  targetNumber: number | null;
  targetType: RepoLabelTargetType;
  action: string;
  actorGithubId: string | null;
  actorLogin: string | null;
};

@Injectable()
export class LabelHandler {
  constructor(
    @InjectRepository(LabelEvent)
    private readonly labelEventRepo: Repository<LabelEvent>,
    @InjectRepository(Issue)
    private readonly issueRepo: Repository<Issue>,
    @InjectRepository(PullRequest)
    private readonly prRepo: Repository<PullRequest>,
  ) {}

  /**
   * Called for issues.labeled/unlabeled and pull_request.labeled/unlabeled events.
   * Logs the event to label_events and updates the labels array on the parent row.
   */
  async handle(
    payload: Record<string, any>,
    source: "issue" | "pr",
  ): Promise<void> {
    const action = payload.action;
    if (action !== "labeled" && action !== "unlabeled") return;

    const repoFullName: string = payload.repository.full_name;
    const label = payload.label;
    const sender = payload.sender;

    const targetNumber: number =
      source === "pr" ? payload.pull_request.number : payload.issue.number;

    // Append to label_events log. Actor's repo role is resolved at read time
    // against the live maintainers table (see pr_labels_by_actor view) — neither
    // the webhook sender nor GraphQL LabeledEvent.actor expose author_association.
    // orIgnore() makes the insert idempotent under the uq_label_events_natural_key
    // constraint; same-delivery retries are already gated upstream by
    // webhook_deliveries, this is defense-in-depth.
    await this.labelEventRepo
      .createQueryBuilder()
      .insert()
      .values({
        repoFullName,
        targetNumber,
        targetType: source,
        labelName: label.name,
        action,
        actorGithubId: sender ? String(sender.id) : null,
        actorLogin: sender?.login ?? null,
        timestamp: new Date().toISOString(),
      })
      .orIgnore()
      .execute();

    // Update current labels snapshot on the parent row
    const currentLabels: string[] =
      source === "pr"
        ? (payload.pull_request.labels ?? []).map((l: any) => l.name)
        : (payload.issue.labels ?? []).map((l: any) => l.name);

    if (source === "pr") {
      await this.prRepo.update(
        { repoFullName, prNumber: targetNumber },
        { labels: currentLabels },
      );
    } else {
      await this.issueRepo.update(
        { repoFullName, issueNumber: targetNumber },
        { labels: currentLabels },
      );
    }
  }

  /**
   * Called for repository-level label.deleted and label.edited events.
   * GitHub applies these transitions repo-wide, so mirror the current
   * target-level label state with per-target events for the scoring views.
   */
  async handleRepoLabel(payload: Record<string, any>): Promise<void> {
    const action = payload.action;
    if (action !== "deleted" && action !== "edited") return;

    const repoFullName: string | undefined = payload.repository?.full_name;
    const labelName: string | undefined = payload.label?.name;
    if (!repoFullName || !labelName) return;

    const sender = payload.sender;
    const actorGithubId = sender?.id != null ? String(sender.id) : null;
    const actorLogin = sender?.login ?? null;
    const timestamp = new Date().toISOString();

    if (action === "deleted") {
      await this.removeRepoLabel(
        repoFullName,
        labelName,
        actorGithubId,
        actorLogin,
        timestamp,
      );
      return;
    }

    const oldName: string | undefined = payload.changes?.name?.from;
    if (!oldName || oldName === labelName) return;

    await this.renameRepoLabel(
      repoFullName,
      oldName,
      labelName,
      actorGithubId,
      actorLogin,
      timestamp,
    );
  }

  private async removeRepoLabel(
    repoFullName: string,
    labelName: string,
    actorGithubId: string | null,
    actorLogin: string | null,
    timestamp: string,
  ): Promise<void> {
    await this.labelEventRepo.manager.transaction(async (manager) => {
      const labelEventRepo = manager.getRepository(LabelEvent);
      const currentTargets = await this.findCurrentRepoLabelTargets(
        labelEventRepo,
        repoFullName,
        labelName,
      );

      const transitionRows = currentTargets.map((target) => ({
        repoFullName: target.repoFullName,
        targetNumber: target.targetNumber,
        targetType: target.targetType,
        labelName,
        action: "unlabeled",
        actorGithubId,
        actorLogin,
        timestamp,
      }));

      await this.insertLabelEvents(labelEventRepo, transitionRows);

      await manager
        .getRepository(PullRequest)
        .createQueryBuilder()
        .update()
        .set({ labels: () => "array_remove(labels, :labelName)" })
        .where("repo_full_name = :repoFullName", { repoFullName })
        .andWhere(":labelName = ANY(labels)", { labelName })
        .execute();

      await manager
        .getRepository(Issue)
        .createQueryBuilder()
        .update()
        .set({ labels: () => "array_remove(labels, :labelName)" })
        .where("repo_full_name = :repoFullName", { repoFullName })
        .andWhere(":labelName = ANY(labels)", { labelName })
        .execute();
    });
  }

  private async renameRepoLabel(
    repoFullName: string,
    oldName: string,
    newName: string,
    actorGithubId: string | null,
    actorLogin: string | null,
    timestamp: string,
  ): Promise<void> {
    await this.labelEventRepo.manager.transaction(async (manager) => {
      const labelEventRepo = manager.getRepository(LabelEvent);
      const currentTargets = await this.findCurrentRepoLabelTargets(
        labelEventRepo,
        repoFullName,
        oldName,
      );

      const transitionRows = currentTargets.flatMap((target) => [
        {
          repoFullName: target.repoFullName,
          targetNumber: target.targetNumber,
          targetType: target.targetType,
          labelName: oldName,
          action: "unlabeled",
          actorGithubId,
          actorLogin,
          timestamp,
        },
        {
          repoFullName: target.repoFullName,
          targetNumber: target.targetNumber,
          targetType: target.targetType,
          labelName: newName,
          action: "labeled",
          actorGithubId: target.actorGithubId,
          actorLogin: target.actorLogin,
          timestamp,
        },
      ]);

      await this.insertLabelEvents(labelEventRepo, transitionRows);

      await manager
        .getRepository(PullRequest)
        .createQueryBuilder()
        .update()
        .set({
          labels: () =>
            "CASE WHEN :newName = ANY(labels) THEN array_remove(labels, :oldName) ELSE array_replace(labels, :oldName, :newName) END",
        })
        .where("repo_full_name = :repoFullName", { repoFullName })
        .andWhere(":oldName = ANY(labels)", { oldName })
        .setParameters({ newName })
        .execute();

      await manager
        .getRepository(Issue)
        .createQueryBuilder()
        .update()
        .set({
          labels: () =>
            "CASE WHEN :newName = ANY(labels) THEN array_remove(labels, :oldName) ELSE array_replace(labels, :oldName, :newName) END",
        })
        .where("repo_full_name = :repoFullName", { repoFullName })
        .andWhere(":oldName = ANY(labels)", { oldName })
        .setParameters({ newName })
        .execute();
    });
  }

  private async findCurrentRepoLabelTargets(
    labelEventRepo: Repository<LabelEvent>,
    repoFullName: string,
    labelName: string,
  ): Promise<CurrentRepoLabelTarget[]> {
    const latestTargets = await labelEventRepo
      .createQueryBuilder("le")
      .select("le.repoFullName", "repoFullName")
      .addSelect("le.targetNumber", "targetNumber")
      .addSelect("le.targetType", "targetType")
      .addSelect("le.action", "action")
      .addSelect("le.actorGithubId", "actorGithubId")
      .addSelect("le.actorLogin", "actorLogin")
      .distinctOn([
        "le.repoFullName",
        "le.targetNumber",
        "le.targetType",
        "le.labelName",
      ])
      .where("le.repoFullName = :repoFullName", { repoFullName })
      .andWhere("le.labelName = :labelName", { labelName })
      .andWhere("le.targetType IN (:...targetTypes)", {
        targetTypes: ["pr", "issue"],
      })
      .orderBy("le.repoFullName", "ASC")
      .addOrderBy("le.targetNumber", "ASC")
      .addOrderBy("le.targetType", "ASC")
      .addOrderBy("le.labelName", "ASC")
      .addOrderBy("le.timestamp", "DESC")
      .getRawMany<CurrentRepoLabelTarget>();

    return latestTargets.filter((target) => target.action === "labeled");
  }

  private async insertLabelEvents(
    labelEventRepo: Repository<LabelEvent>,
    labelEvents: Partial<LabelEvent>[],
  ): Promise<void> {
    if (labelEvents.length === 0) return;

    await labelEventRepo
      .createQueryBuilder()
      .insert()
      .values(labelEvents)
      .orIgnore()
      .execute();
  }
}
