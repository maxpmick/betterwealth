import type { HonoRequest } from "hono";
import { z } from "zod";
import { AppError } from "./errors";

const listCursorSchema = z.object({
  sortKey: z.string().min(1),
  id: z.string().min(1),
});

export type ListCursor = z.infer<typeof listCursorSchema>;

/**
 * Opaque keyset cursor for descending list endpoints, mirroring /transactions:
 * base64url-encoded JSON of the last row's sort key and id.
 */
export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeListCursor(value: string): ListCursor {
  try {
    return listCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new AppError("Invalid cursor", 422, "validation_failed");
  }
}

/**
 * Parse the shared `limit`/`cursor` query params. `limit` defaults to and is
 * capped at `maxLimit` — the endpoint's previous hardcoded limit — so
 * parameterless requests behave exactly as before.
 */
export function listPageParams(request: HonoRequest, maxLimit: number) {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(maxLimit)
    .default(maxLimit)
    .parse(request.query("limit"));
  const cursorValue = request.query("cursor");
  return { limit, cursor: cursorValue ? decodeListCursor(cursorValue) : null };
}

/**
 * Slice a `limit + 1` row fetch into the page rows and the response `page`
 * block. `cursorOf` reads the sort key and id off the last returned row.
 */
export function paginateList<Row>(
  fetched: Row[],
  limit: number,
  cursorOf: (row: Row) => ListCursor,
) {
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const lastRow = rows.at(-1);
  return {
    rows,
    page: {
      cursor: hasMore && lastRow ? encodeListCursor(cursorOf(lastRow)) : null,
      hasMore,
    },
  };
}
