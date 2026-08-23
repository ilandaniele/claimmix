/**
 * GET /api/admin/billing?month=YYYY-MM
 *
 * What to invoice this tenant for a calendar month, and what it cost us to
 * serve them. Admin-only, scoped to the caller's own tenant by an explicit
 * tenant_id filter on every query.
 *
 * BILLABLE UNIT: a claim the agent actually recognised as a claim
 * (`cases.is_claim = true`). Mail the agent correctly rejected as
 * not-a-claim is NOT billed — charging for filtered spam would make the
 * filter look like a revenue source instead of a feature. Cases that never
 * produced a verdict (failed or still processing) are not billed either.
 *
 * The full breakdown is returned, not just the billable number, so an invoice
 * can be defended line by line when a client questions it.
 *
 * A month that has ENDED is answered from the copy stored when it closed, and
 * closed on the first request if it had not been — see
 * `@/server/billing/statement`. The current month is always a live count.
 * `frozen` in the response says which of the two you are looking at, because
 * "this number can still move" is part of the answer.
 *
 * No PII is returned — counts and money only.
 */

import { ok, err } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/require-admin";
import { resolveBillingPeriod } from "@/lib/billing/period";
import { getStatement } from "@/server/billing/statement";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { userRow } = await requireAdmin();

    const range = resolveBillingPeriod(new URL(request.url).searchParams.get("month"));
    if (!range) {
      return err(new Error("INVALID_MONTH: expected format YYYY-MM"));
    }

    const statement = await getStatement(userRow.tenant_id, range);
    if (!statement) {
      return err(new Error("TENANT_NOT_FOUND"));
    }

    return ok(statement);
  } catch (e) {
    return err(e);
  }
}
