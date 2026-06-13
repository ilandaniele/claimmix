import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db, tables } from "@/lib/db";

const TRAINING_LIMIT = 8_000;

export async function loadAgentTraining(tenantId: string): Promise<string> {
  const t = tables.agentTraining;

  let data: Array<{ content: string | null }>;
  try {
    data = await db
      .select({ content: t.content })
      .from(t)
      .where(and(eq(t.tenant_id, tenantId), eq(t.enabled, true)))
      .orderBy(sql`${t.updated_at} DESC NULLS LAST`)
      .limit(5);
  } catch (e) {
    console.error("[agent-training] load error:", (e as { code?: string })?.code);
    return "";
  }

  return data
    .map((row) => row.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, TRAINING_LIMIT);
}
