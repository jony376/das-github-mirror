import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  Repo,
  PullRequest,
  Issue,
  Review,
  Comment,
  ReviewComment,
  LabelEvent,
} from "../entities";
import { FETCH_QUEUE } from "../queue/constants";
import { WebhookController } from "./webhook.controller";
import { WebhookService } from "./webhook.service";
import { WebhookPruneService } from "./webhook-prune.service";
import { PrReconcileService } from "./pr-reconcile.service";
import { RepoBackfillScheduleService } from "./repo-backfill-schedule.service";
import { PullRequestHandler } from "./handlers/pull-request.handler";
import { IssueHandler } from "./handlers/issue.handler";
import { ReviewHandler } from "./handlers/review.handler";
import { CommentHandler } from "./handlers/comment.handler";
import { ReviewCommentHandler } from "./handlers/review-comment.handler";
import { LabelHandler } from "./handlers/label.handler";
import { InstallationHandler } from "./handlers/installation.handler";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Repo,
      PullRequest,
      Issue,
      Review,
      Comment,
      ReviewComment,
      LabelEvent,
    ]),
    BullModule.registerQueue({ name: FETCH_QUEUE }),
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookPruneService,
    PrReconcileService,
    RepoBackfillScheduleService,
    PullRequestHandler,
    IssueHandler,
    ReviewHandler,
    CommentHandler,
    ReviewCommentHandler,
    LabelHandler,
    InstallationHandler,
  ],
})
export class WebhookModule {}
