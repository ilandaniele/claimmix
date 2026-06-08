import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

const TRAINING_LIMIT = 8_000;

export async function loadAgentTraining(
  supabase: SupabaseClient,
  tenantId: string
): Promise<string> {
  const { data, error } = await (supabase as any)
    .from("agent_training")
    .select("content")
    .eq("tenant_id", tenantId)
    .eq("enabled", true)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(5);

  if (error || !data) {
    if (error) {
      console.error("[agent-training] load error:", error.code);
    }
    return "";
  }

  return (data as Array<{ content: string | null }>)
    .map((row) => row.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, TRAINING_LIMIT);
}
