import { BadRequestException } from "@nestjs/common";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export interface PaginationParams {
  limit: number;
  cursor: DecodedCursor | null;
}

export interface DecodedCursor {
  createdAt: string;
  repoFullName: string;
  number: number;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

interface CursorPayload {
  created_at: string;
  repo_full_name: string;
  number: number;
}

export function parsePaginationQuery(
  limitRaw?: string,
  cursorRaw?: string,
): PaginationParams | null {
  const hasLimit = limitRaw !== undefined && limitRaw !== "";
  const hasCursor = cursorRaw !== undefined && cursorRaw !== "";
  if (!hasLimit && !hasCursor) {
    return null;
  }

  let limit = DEFAULT_PAGE_LIMIT;
  if (hasLimit) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException("limit must be a positive integer");
    }
    limit = Math.min(parsed, MAX_PAGE_LIMIT);
  }

  let cursor: DecodedCursor | null = null;
  if (hasCursor) {
    cursor = decodeCursor(cursorRaw);
  }

  return { limit, cursor };
}

export function decodeCursor(raw: string): DecodedCursor {
  let payload: CursorPayload;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    payload = JSON.parse(json) as CursorPayload;
  } catch {
    throw new BadRequestException("cursor is invalid");
  }

  if (
    typeof payload.created_at !== "string" ||
    typeof payload.repo_full_name !== "string" ||
    typeof payload.number !== "number" ||
    !Number.isFinite(payload.number)
  ) {
    throw new BadRequestException("cursor is malformed");
  }

  return {
    createdAt: payload.created_at,
    repoFullName: payload.repo_full_name.toLowerCase(),
    number: payload.number,
  };
}

export function encodeCursor(row: {
  created_at: string | Date;
  repo_full_name: string;
  pr_number?: number;
  issue_number?: number;
}): string {
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at);
  const number = row.pr_number ?? row.issue_number;
  if (number === undefined) {
    throw new Error("encodeCursor requires pr_number or issue_number");
  }

  const payload: CursorPayload = {
    created_at: createdAt,
    repo_full_name: String(row.repo_full_name).toLowerCase(),
    number,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function buildPaginatedResponse<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  pickCursorRow: (row: T) => {
    created_at: string | Date;
    repo_full_name: string;
    pr_number?: number;
    issue_number?: number;
  },
): PaginatedResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && items.length > 0
      ? encodeCursor(pickCursorRow(items[items.length - 1]))
      : null;

  return { items, nextCursor };
}
