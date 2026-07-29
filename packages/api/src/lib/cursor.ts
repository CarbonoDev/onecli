/**
 * Opaque keyset-cursor helpers for the directory-scale list envelope.
 *
 * Every `/v1/org/*` directory list answers with `{ data, nextCursor }`; the
 * cursor is an opaque base64url blob encoding the ordering key of the last row
 * on the page. Callers must never parse it — the client only ever echoes it
 * back (`fetchAllPages` drains pages until `nextCursor` is null).
 *
 * A malformed cursor is treated as ABSENT (first page) rather than an error: a
 * stale bookmark or a truncated query string must never 500, and a cursor
 * carries no authority — the scope always comes from the caller's auth context.
 *
 * Pure and dependency-free; shared by every directory list.
 */

/** The cursor envelope shared by every directory-scale list. */
export interface DirectoryPage<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Part separator. NUL can't occur in the values we encode (ISO timestamps and
 * ids), so a split is unambiguous.
 */
const SEPARATOR = "\u0000";

export const DIRECTORY_LIMIT_MIN = 1;
/** The web client asks for 200 at a time (`use-groups.ts`); that is the ceiling. */
export const DIRECTORY_LIMIT_MAX = 200;
export const DIRECTORY_LIMIT_DEFAULT = 50;

/** Encode an ordering key (e.g. `[createdAtIso, userId]`) into an opaque cursor. */
export const encodeCursor = (parts: string[]): string =>
  Buffer.from(parts.join(SEPARATOR), "utf8").toString("base64url");

/**
 * Decode a cursor back into its `expectedParts` ordering-key components, or
 * `null` when it is absent or malformed (wrong arity, empty component,
 * undecodable) — callers then serve the first page.
 */
export const decodeCursor = (
  raw: string | undefined | null,
  expectedParts: number,
): string[] | null => {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!decoded) return null;
  const parts = decoded.split(SEPARATOR);
  if (parts.length !== expectedParts) return null;
  if (parts.some((part) => part.length === 0)) return null;
  return parts;
};

/**
 * Clamp a requested page size into `[1, 200]`. The route schemas reject
 * out-of-range values outright; this is the service-level backstop so a direct
 * caller can never ask for an unbounded page.
 */
export const clampDirectoryLimit = (limit?: number): number => {
  if (limit === undefined || !Number.isFinite(limit))
    return DIRECTORY_LIMIT_DEFAULT;
  return Math.min(
    DIRECTORY_LIMIT_MAX,
    Math.max(DIRECTORY_LIMIT_MIN, Math.trunc(limit)),
  );
};

/**
 * Build the page envelope from an over-fetched row set: query `limit + 1` rows,
 * hand them here, and the extra row (if any) becomes the `nextCursor` signal
 * rather than a count query. `keyOf` must return the SAME ordering key the
 * query sorts by, or pagination will skip/repeat rows.
 */
export const toDirectoryPage = <T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => string[],
): DirectoryPage<T> => {
  if (rows.length <= limit) return { data: rows, nextCursor: null };
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    nextCursor: last === undefined ? null : encodeCursor(keyOf(last)),
  };
};
