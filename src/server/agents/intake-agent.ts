import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { runEmailExtractionWorker } from "@/server/worker/extract";

type IntakeChannel = "email" | "email_sim" | "whatsapp" | "whatsapp_sim";

export interface IntakeAgentInput {
  caseId: string;
  tenantId: string;
  userId?: string | null;
  source?: "gmail" | "whatsapp" | "worker" | "cron" | "simulate" | "manual";
}

export interface IntakeAgentResult {
  ok: boolean;
  caseId: string;
  tenantId: string;
  channel?: IntakeChannel;
  action:
    | "extract_email"
    | "extract_whatsapp"
    | "skip_unsupported_channel"
    | "case_not_found";
}

export interface WhatsAppIntakeInput {
  tenantId: string;
  from: string;
  body: string;
  providerMessageId?: string | null;
  threadId?: string | null;
  userId?: string | null;
}

export interface WhatsAppIntakeResult {
  caseId: string;
  tenantId: string;
  created: boolean;
  agent: IntakeAgentResult;
}

export interface StoredWhatsAppIntake {
  caseId: string;
  tenantId: string;
  created: boolean;
}

type CaseRow = {
  id: string;
  tenant_id: string;
  channel: IntakeChannel;
  status: string;
};

/**
 * Bounded intake agent for inbound claim messages.
 *
 * This is intentionally not a free-form autonomous agent. It has a small action
 * set: inspect the stored case, choose the channel-specific extraction action,
 * write a non-PII decision audit event, and delegate to the extraction worker.
 */
export async function runIntakeAgent(input: IntakeAgentInput): Promise<IntakeAgentResult> {
  const supabase = createServiceClient();

  const { data: caseRow, error } = await (supabase as any)
    .from("cases")
    .select("id,tenant_id,channel,status")
    .eq("id", input.caseId)
    .eq("tenant_id", input.tenantId)
    .single();

  if (error || !caseRow) {
    return {
      ok: false,
      caseId: input.caseId,
      tenantId: input.tenantId,
      action: "case_not_found",
    };
  }

  const row = caseRow as CaseRow;
  const action = chooseAction(row.channel);

  await writeAuditLog({
    tenant_id: input.tenantId,
    actor_id: input.userId ?? null,
    event_type: "intake.agent_decision",
    target_type: "case",
    target_id: input.caseId,
    payload: {
      source: input.source ?? "worker",
      channel: row.channel,
      action,
      status: row.status,
    },
  });

  if (action === "extract_email" || action === "extract_whatsapp") {
    await runEmailExtractionWorker(input.caseId, input.tenantId, input.userId ?? null);
    return {
      ok: true,
      caseId: input.caseId,
      tenantId: input.tenantId,
      channel: row.channel,
      action,
    };
  }

  return {
    ok: false,
    caseId: input.caseId,
    tenantId: input.tenantId,
    channel: row.channel,
    action,
  };
}

export async function createWhatsAppIntakeAndRunAgent(
  input: WhatsAppIntakeInput
): Promise<WhatsAppIntakeResult> {
  const stored = await createWhatsAppIntake(input);
  const agent = await runIntakeAgent({
    caseId: stored.caseId,
    tenantId: input.tenantId,
    userId: input.userId ?? null,
    source: "whatsapp",
  });

  return {
    ...stored,
    agent,
  };
}

export async function createWhatsAppIntake(
  input: WhatsAppIntakeInput
): Promise<StoredWhatsAppIntake> {
  const supabase = createServiceClient();
  const threadId = input.threadId?.trim() || input.from.trim();
  const providerMessageId = input.providerMessageId?.trim() || null;

  const existingCaseId = await findExistingWhatsAppCase(supabase, input.tenantId, threadId);
  const caseId = existingCaseId ?? await createWhatsAppCase(supabase, input.tenantId, threadId);

  await insertWhatsAppMessage(supabase, {
    caseId,
    tenantId: input.tenantId,
    from: input.from,
    body: input.body,
    providerMessageId,
    threadId,
  });

  await writeAuditLog({
    tenant_id: input.tenantId,
    actor_id: input.userId ?? null,
    event_type: AuditEvent.EMAIL_RECEIVED,
    target_type: "case",
    target_id: caseId,
    payload: {
      channel: "whatsapp",
      action: existingCaseId ? "thread_update" : "new_case",
      provider: "whatsapp",
    },
  });

  return {
    caseId,
    tenantId: input.tenantId,
    created: !existingCaseId,
  };
}

function chooseAction(channel: IntakeChannel): IntakeAgentResult["action"] {
  if (channel === "email" || channel === "email_sim") return "extract_email";
  if (channel === "whatsapp" || channel === "whatsapp_sim") return "extract_whatsapp";
  return "skip_unsupported_channel";
}

async function findExistingWhatsAppCase(
  supabase: SupabaseClient,
  tenantId: string,
  threadId: string
): Promise<string | null> {
  const { data } = await (supabase as any)
    .from("cases")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("channel", "whatsapp")
    .eq("email_thread_id", threadId)
    .in("status", [
      "recibido",
      "info_faltante",
      "confirmacion_pendiente",
      "requiere_especialista",
      "listo",
      "listo_para_core",
    ])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.id ?? null;
}

async function createWhatsAppCase(
  supabase: SupabaseClient,
  tenantId: string,
  threadId: string
): Promise<string> {
  const { data, error } = await (supabase as any)
    .from("cases")
    .insert({
      tenant_id: tenantId,
      channel: "whatsapp",
      status: "recibido",
      email_thread_id: threadId,
      is_claim: true,
      claim_type: null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`whatsapp_case_insert_failed:${error?.code ?? "no_data"}`);
  }

  return data.id as string;
}

async function insertWhatsAppMessage(
  supabase: SupabaseClient,
  input: {
    caseId: string;
    tenantId: string;
    from: string;
    body: string;
    providerMessageId: string | null;
    threadId: string;
  }
): Promise<void> {
  const now = new Date().toISOString();

  const { error: claimMessageError } = await (supabase as any)
    .from("claim_messages")
    .insert({
      case_id: input.caseId,
      tenant_id: input.tenantId,
      direction: "inbound",
      provider: "whatsapp",
      provider_message_id: input.providerMessageId,
      thread_id: input.threadId,
      from_addr: input.from,
      subject: "WhatsApp",
      body_text: input.body,
      body_html: null,
      headers: {},
      raw_payload: {},
      status: "received",
      received_at: now,
    });

  if (claimMessageError?.code === "23505") return;
  if (claimMessageError) {
    throw new Error(`whatsapp_claim_message_insert_failed:${claimMessageError.code}`);
  }

  await (supabase as any)
    .from("raw_messages")
    .insert({
      case_id: input.caseId,
      tenant_id: input.tenantId,
      channel: "whatsapp",
      from_addr: input.from,
      subject: "WhatsApp",
      body: input.body,
      received_at: now,
    });
}
