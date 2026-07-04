import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  Issue,
  LabelEvent,
  PrFile,
  PrFileContent,
  PullRequest,
  Repo,
  Review,
} from "../entities";
import { GitHubFetcherService } from "../webhook/github-fetcher.service";
import { MaintainerPopulateService } from "./maintainer-populate.service";

@Module({
  // GitHubFetcherService injects these repositories; the populate service itself
  // only needs Repo (it reads the registered-repo list and writes maintainers as
  // raw SQL via DataSource). This provides a self-contained GitHubFetcherService
  // instance — its own installation-token cache, independent of the QueueModule
  // copy.
  imports: [
    TypeOrmModule.forFeature([
      Repo,
      PullRequest,
      Issue,
      Review,
      LabelEvent,
      PrFile,
      PrFileContent,
    ]),
  ],
  providers: [GitHubFetcherService, MaintainerPopulateService],
})
export class MaintainerModule {}
