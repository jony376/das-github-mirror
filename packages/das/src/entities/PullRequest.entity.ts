import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "pull_requests" })
export class PullRequest {
  @PrimaryColumn({ name: "repo_full_name" })
  repoFullName: string;

  @PrimaryColumn({ name: "pr_number" })
  prNumber: number;

  @Column({ name: "author_github_id", nullable: true })
  authorGithubId: string;

  @Column({ name: "author_login", nullable: true })
  authorLogin: string;

  @Column({ name: "author_association", nullable: true })
  authorAssociation: string;

  @Column({ type: "text", nullable: true })
  title: string;

  @Column({ type: "text", nullable: true })
  body: string | null;

  @Column()
  state: string;

  @Column({ name: "created_at", type: "timestamptz" })
  createdAt: string;

  @Column({ name: "closed_at", type: "timestamptz", nullable: true })
  closedAt: string;

  @Column({ name: "merged_at", type: "timestamptz", nullable: true })
  mergedAt: string;

  // ISO string on write, Date on read (TypeORM hydrates timestamptz).
  @Column({ name: "updated_at", type: "timestamptz", nullable: true })
  updatedAt: Date | string | null;

  @Column({ name: "last_edited_at", type: "timestamptz", nullable: true })
  lastEditedAt: string | null;

  @Column({ name: "merged_by_login", nullable: true })
  mergedByLogin: string;

  @Column({ name: "base_ref", nullable: true })
  baseRef: string;

  @Column({ name: "head_ref", nullable: true })
  headRef: string;

  @Column({ name: "head_repo_full_name", nullable: true })
  headRepoFullName: string;

  @Column({ name: "head_sha", nullable: true })
  headSha: string;

  @Column({ name: "base_sha", nullable: true })
  baseSha: string;

  @Column({ name: "merge_base_sha", nullable: true })
  mergeBaseSha: string;

  @Column({ nullable: true })
  additions: number;

  @Column({ nullable: true })
  deletions: number;

  @Column({ name: "commits_count", nullable: true })
  commitsCount: number;

  @Column({ type: "text", array: true, nullable: true })
  labels: string[] | null;

  @Column({
    name: "closing_issue_numbers",
    type: "int",
    array: true,
    nullable: true,
  })
  closingIssueNumbers: number[];

  @Column({ name: "scoring_data_stored", default: false })
  scoringDataStored: boolean;
}
