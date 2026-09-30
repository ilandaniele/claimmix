import "server-only";

import { eq } from "drizzle-orm";
import { enTenant } from "@/data/scope";
import { outboundMessages } from "@/lib/db/schema";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

/** Whether anything has already gone out to the claimant on this case. */
export async function hasPriorOutbound(caseId: string, tenantId: string): Promise<boolean> {
  try {
    const rows = await enTenant({ tenantId }, (db) =>
      db
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(eq(outboundMessages.case_id, caseId))
        .limit(1)
    );
    return rows.length > 0;
  } catch (err) {
    // Fall back to the first-contact wording: greeting someone twice is a
    // smaller error than closing a conversation that never happened.
    logger.error({ code: errorCode(err) }, "orchestrate.failed_to_check_prior_outbound");
    return false;
  }
}
