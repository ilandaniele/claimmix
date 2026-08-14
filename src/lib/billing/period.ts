/**
 * Resolving "which month am I billing?" into a concrete date range.
 *
 * Lives next to the invoice arithmetic rather than inside the API route for the
 * same reason: getting the period wrong bills the client for someone else's
 * month, and that is not a mistake anyone notices from the total alone. Pure
 * and side-effect free so every boundary can be tested — December rolling into
 * January being the one that historically breaks.
 */

export interface BillingPeriod {
  /** Inclusive start, ISO-8601 UTC. */
  start: string;
  /** EXCLUSIVE end, ISO-8601 UTC — the first instant of the next month. */
  next: string;
  /** Canonical `YYYY-MM` label for the period. */
  month: string;
}

/** Widest range we accept. Outside this, the input is a typo, not a period. */
const MIN_YEAR = 2020;
const MAX_YEAR = 2100;

/**
 * Resolves a `YYYY-MM` string to a half-open UTC range `[start, next)`.
 *
 * Half-open on purpose: a closed range needs "the last instant of the month",
 * which is unrepresentable without picking an arbitrary precision, and any
 * choice there either double-counts or drops claims created in the final
 * second. `created_at >= start AND created_at < next` has neither problem.
 *
 * Returns null on anything malformed instead of falling back to the current
 * month — a typo'd month must not quietly produce a different period's invoice,
 * because the resulting number looks perfectly plausible.
 *
 * @param raw   `YYYY-MM`, or null/empty for the current month.
 * @param now   Injectable clock; defaults to the real one.
 */
export function resolveBillingPeriod(
  raw: string | null | undefined,
  now: Date = new Date()
): BillingPeriod | null {
  let year: number;
  let month: number; // 1-12

  if (raw === null || raw === undefined || raw === "") {
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1;
  } else {
    const m = /^(\d{4})-(\d{2})$/.exec(raw);
    if (!m) return null;
    year = Number(m[1]);
    month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    if (year < MIN_YEAR || year > MAX_YEAR) return null;
  }

  // Date.UTC normalises month 12 (0-indexed) into January of the next year, so
  // December needs no special case — but it does need a test, which it has.
  const start = new Date(Date.UTC(year, month - 1, 1));
  const next = new Date(Date.UTC(year, month, 1));

  return {
    start: start.toISOString(),
    next: next.toISOString(),
    month: `${year}-${String(month).padStart(2, "0")}`,
  };
}
