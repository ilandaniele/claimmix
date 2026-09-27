/**
 * Pure utility functions for realtime case management.
 * Extracted from useCasesRealtime.ts to be testable without Neon browser client.
 *
 * No browser dependencies — safe to import in unit tests.
 */

import type { CaseRow } from "@/server/cases/list";

/**
 * Merge realtime updates into a local cases array.
 * INSERT: prepends to the front (newest first), skips duplicates.
 * UPDATE: replaces the matching row in-place.
 */
export function mergeCaseUpdate(
  cases: CaseRow[],
  updated: CaseRow,
  type: "insert" | "update"
): CaseRow[] {
  if (type === "insert") {
    const exists = cases.some((c) => c.id === updated.id);
    if (exists) return cases;
    return [updated, ...cases];
  }
  return cases.map((c) => (c.id === updated.id ? updated : c));
}
