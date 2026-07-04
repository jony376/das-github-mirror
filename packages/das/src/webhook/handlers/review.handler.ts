/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Repo, Review } from "../../entities";

@Injectable()
export class ReviewHandler {
  constructor(
    @InjectRepository(Review)
    private readonly reviewRepo: Repository<Review>,
    @InjectRepository(Repo)
    private readonly repoRepo: Repository<Repo>,
  ) {}

  async handle(payload: Record<string, any>): Promise<void> {
    const review = payload.review;
    const repoFullName: string = payload.repository.full_name;

    if (payload.action === "dismissed") {
      await this.reviewRepo.delete({
        repoFullName,
        prNumber: payload.pull_request.number,
        reviewerGithubId: String(review.user.id),
        submittedAt: review.submitted_at,
      });
      await this.repoRepo.update(repoFullName, {
        lastEventAt: new Date().toISOString(),
      });
      return;
    }

    // Only store submitted reviews (not pending)
    if (payload.action !== "submitted") return;

    const data: Partial<Review> = {
      repoFullName,
      prNumber: payload.pull_request.number,
      reviewerGithubId: String(review.user.id),
      reviewerLogin: review.user.login,
      reviewerAssociation: review.author_association,
      reviewState: review.state.toUpperCase(),
      submittedAt: review.submitted_at,
    };

    await this.reviewRepo.upsert(data, [
      "repoFullName",
      "prNumber",
      "reviewerGithubId",
      "submittedAt",
    ]);

    await this.repoRepo.update(repoFullName, {
      lastEventAt: new Date().toISOString(),
    });
  }
}
