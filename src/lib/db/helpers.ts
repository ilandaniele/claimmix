import { ilike, or, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "./index";

/** Returns the first row of a result set, or null when empty. */
export const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

/** Escapes LIKE/ILIKE wildcard characters in user-supplied search input. */
const escapeLike = (q: string): string => q.replace(/[\\%_]/g, "\\$&");

/**
 * Case-insensitive substring match across any of the given columns:
 * `WHERE col1 ILIKE %q% OR col2 ILIKE %q% OR ...`
 */
export function ilikeAny(cols: AnyPgColumn[], q: string): SQL | undefined {
  const pattern = `%${escapeLike(q)}%`;
  return or(...cols.map((c) => ilike(c, pattern)));
}

/**
 * Counts rows in a table (optionally filtered). Thin wrapper over
 * `db.$count`, available in the installed drizzle-orm (0.45.x).
 */
export async function countRows(
  table: PgTable | SQLWrapper,
  where?: SQL,
): Promise<number> {
  return db.$count(table, where);
}
