/**
 * /api/admin/training-examples - approved/rejected training examples list.
 */

import { desc, eq } from "drizzle-orm";

import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { ok, err } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db, userRow } = await requireAdmin();
    const t = tables.trainingExamples;
    const examples = await db
      .select({
        id: t.id,
        agent_run_id: t.agent_run_id,
        case_id: t.case_id,
        claim_type: t.claim_type,
        input_payload: t.input_payload,
        expected_output: t.expected_output,
        status: t.status,
        approved_at: t.approved_at,
        created_at: t.created_at,
      })
      .from(t)
      .where(eq(t.tenant_id, userRow.tenant_id))
      .orderBy(desc(t.created_at))
      .limit(100);
    return ok({ examples });
  } catch (e) {
    return err(e);
  }
}
