import { BadRequestException } from "@nestjs/common";

/** GitHub owner/repo pattern: alphanum + `.`, `_`, `-`, length reasonable. */
export const REPO_FULL_NAME_PATTERN = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export function validateRepoFullName(value: unknown): string {
  if (typeof value !== "string" || !REPO_FULL_NAME_PATTERN.test(value)) {
    throw new BadRequestException(
      'repoFullName must match "owner/repo" (alphanumerics, dot, dash, underscore)',
    );
  }
  return value;
}
