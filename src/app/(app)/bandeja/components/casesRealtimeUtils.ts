/**
 * Pure utility functions for realtime case management.
 * Extracted from useCasesRealtime.ts to be testable without Supabase browser client.
 *
 * No browser dependencies — safe to import in unit tests.
 */

import type { CaseRow } from "@/server/cases/list";
import type { CaseStatus } from "@/lib/schemas/cases";

/**
 * Generate a case display number from a UUID.
 * Uses the last 8 hex chars formatted as SIN-XXXX-XXXX.
 */
export function formatCaseNumber(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

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

/**
 * Compute per-status counts from a cases array.
 */
export function computeStatusCounts(
  cases: CaseRow[]
): Map<CaseStatus | "todos", number> {
  const counts = new Map<CaseStatus | "todos", number>([
    ["todos", cases.length],
    ["procesando", 0],
    ["listo", 0],
    ["esperando", 0],
    ["escalado", 0],
    ["cerrado", 0],
  ]);

  for (const c of cases) {
    const current = counts.get(c.status) ?? 0;
    counts.set(c.status, current + 1);
  }

  return counts;
}
