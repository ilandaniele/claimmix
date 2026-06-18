import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
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
  let caseRow: CaseRow | null;
  try {
    const c = tables.cases;
    caseRow = (firstRow(
      await db
        .select({
          id: c.id,
          tenant_id: c.tenant_id,
          channel: c.channel,
          status: c.status,
        })
        .from(c)
        .where(and(eq(c.id, input.caseId), eq(c.tenant_id, input.tenantId)))
        .limit(1)
    ) as CaseRow | null);
  } catch {
    caseRow = null;
  }

  if (!caseRow) {
    return {
      ok: false,
      caseId: input.caseId,
      tenantId: input.tenantId,
      action: "case_not_found",
    };
  }

  const row = caseRow;
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
  const threadId = input.threadId?.trim() || input.from.trim();
  const providerMessageId = input.providerMessageId?.trim() || null;

  const existingCaseId = await findExistingWhatsAppCase(input.tenantId, threadId);
  const caseId = existingCaseId ?? await createWhatsAppCase(input.tenantId, threadId);

  await insertWhatsAppMessage({
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
  tenantId: string,
  threadId: string
): Promise<string | null> {
  try {
    const c = tables.cases;
    const data = firstRow(
      await db
        .select({ id: c.id })
        .from(c)
        .where(
          and(
            eq(c.tenant_id, tenantId),
            eq(c.channel, "whatsapp"),
            eq(c.email_thread_id, threadId),
            inArray(c.status, [
              "recibido",
              "info_faltante",
              "confirmacion_pendiente",
              "requiere_especialista",
              "listo",
              "listo_para_core",
            ])
          )
        )
        .orderBy(desc(c.created_at))
        .limit(1)
    );

    return data?.id ?? null;
  } catch {
    // Neon swallowed query errors here (data would be null) — preserve that.
    return null;
  }
}

async function createWhatsAppCase(
  tenantId: string,
  threadId: string
): Promise<string> {
  let data: { id: string } | null;
  try {
    data = firstRow(
      await db
        .insert(tables.cases)
        .values({
          tenant_id: tenantId,
          channel: "whatsapp",
          status: "recibido",
          email_thread_id: threadId,
          is_claim: true,
          claim_type: null,
        })
        .returning({ id: tables.cases.id })
    );
  } catch (e) {
    const code = (e as { code?: string })?.code;
    throw new Error(`whatsapp_case_insert_failed:${code ?? "no_data"}`);
  }

  if (!data) {
    throw new Error(`whatsapp_case_insert_failed:no_data`);
  }

  return data.id;
}

async function insertWhatsAppMessage(
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

  try {
    await db.insert(tables.claimMessages).values({
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
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") return;
    throw new Error(`whatsapp_claim_message_insert_failed:${code}`);
  }

  try {
    await db.insert(tables.rawMessages).values({
      case_id: input.caseId,
      tenant_id: input.tenantId,
      channel: "whatsapp",
      from_addr: input.from,
      subject: "WhatsApp",
      body: input.body,
      received_at: now,
    });
  } catch {
    // The Neon call ignored insert errors here — preserve that behaviour.
  }
}
