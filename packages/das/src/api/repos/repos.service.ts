/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, IsNull, Not, Raw, Repository } from "typeorm";
import { Repo } from "../../entities";

@Injectable()
export class ReposService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  async getMaintainers(
    owner: string,
    repo: string,
  ): Promise<{
    repo_full_name: string;
    generated_at: string;
    maintainers: unknown[];
  }> {
    const repoFullName = `${owner}/${repo}`;

    // Reads the live maintainers table (direct collaborators + org members),
    // populated by MaintainerPopulateService. Every row is already a maintainer
    // (OWNER/MEMBER/COLLABORATOR), so no association filter is needed.
    const rows = await this.dataSource.query(
      `
      SELECT
        m.github_id   AS github_id,
        m.login       AS login,
        m.association AS association
      FROM maintainers m
      WHERE m.repo_full_name = LOWER($1)
      ORDER BY m.github_id
      `,
      [repoFullName],
    );

    return {
      repo_full_name: repoFullName.toLowerCase(),
      generated_at: new Date().toISOString(),
      maintainers: rows,
    };
  }

  async getInstallationStatus(
    owner: string,
    repo: string,
  ): Promise<{ repo_full_name: string; installed: boolean }> {
    const repoFullName = `${owner}/${repo}`;

    // Case-insensitive match (#120); installed regardless of `registered`.
    const count = await this.repoRepo.count({
      where: {
        repoFullName: Raw((alias) => `LOWER(${alias}) = LOWER(:repoFullName)`, {
          repoFullName,
        }),
        installationId: Not(IsNull()),
      },
    });

    return {
      repo_full_name: repoFullName.toLowerCase(),
      installed: count > 0,
    };
  }
}
