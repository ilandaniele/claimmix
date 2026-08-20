import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { downloadWhatsAppMedia, type WhatsAppMediaRef } from "@/server/whatsapp/cloud-api";
import { rehostAndRecordAttachments, type EmailAttachment } from "@/server/email/rehost-attachments";
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
  /** Photos, documents or audio the message carried, not yet downloaded. */
  media?: WhatsAppMediaRef[];
  /**
   * True for the simulation and BSP-adapter path, whose phone numbers are
   * invented.
   *
   * It lands on the case as channel `whatsapp_sim`, and the messenger for that
   * channel records what it would have said without sending. Answering is now
   * the orchestrator's job rather than the route's, so "this route does not
   * pass a reply address" is no longer a guarantee — the case has to carry it.
   * Messaging a made-up number is how a WhatsApp Business account gets flagged.
   */
  simulated?: boolean;
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

  const channel = input.simulated ? "whatsapp_sim" : "whatsapp";
  const existingCaseId = await findExistingWhatsAppCase(input.tenantId, threadId, channel);
  const caseId =
    existingCaseId ?? (await createWhatsAppCase(input.tenantId, threadId, channel));

  const claimMessageId = await insertWhatsAppMessage({
    caseId,
    tenantId: input.tenantId,
    from: input.from,
    body: input.body,
    providerMessageId,
    threadId,
  });

  if (claimMessageId && input.media?.length) {
    await storeWhatsAppMedia(input.tenantId, caseId, claimMessageId, input.media);
  }

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

/**
 * Download the message's media and put it where the email attachments live.
 *
 * The agent's own reply tells people to send photos through the chat, and for
 * months the file was thrown away: the payload names the media, the bytes are
 * behind a second Graph call nobody made, so a photo of a crumpled bumper was
 * stored as the text "[Imagen adjunta sin texto]".
 *
 * Reuses the email rehost pipeline — same bucket, same validation, same
 * content-hash dedup, same claim_attachments rows — so an analyst sees one
 * kind of attachment regardless of how it arrived.
 *
 * Best-effort throughout. A photo that fails to download is a gap in the
 * claim; losing the message that carried it would be worse.
 */
async function storeWhatsAppMedia(
  tenantId: string,
  caseId: string,
  claimMessageId: string,
  media: WhatsAppMediaRef[]
): Promise<void> {
  try {
    const downloaded: EmailAttachment[] = [];

    for (const ref of media) {
      // Bytes in hand skip the round trip. Only the rehearsal and the BSP
      // adapter arrive that way; a real Cloud API message never does.
      const file = ref.data
        ? { data: ref.data, mimeType: ref.mimeType }
        : await downloadWhatsAppMedia(ref.id);
      if (!file) continue;
      downloaded.push({
        Name: ref.filename,
        Content: file.data.toString("base64"),
        ContentType: file.mimeType || ref.mimeType,
        ContentLength: file.data.length,
      });
    }

    if (downloaded.length === 0) return;

    const results = await rehostAndRecordAttachments({
      attachments: downloaded,
      tenantId,
      caseId,
      messageId: claimMessageId,
      budgetMs: 10_000,
    });

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "whatsapp.media_stored",
        case_id: caseId,
        attempted: media.length,
        downloaded: downloaded.length,
        stored: results.filter((r) => r.stored).length,
      })
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "whatsapp.media_failed",
        case_id: caseId,
        error: err instanceof Error ? err.name : "UnknownError",
      })
    );
  }
}

function chooseAction(channel: IntakeChannel): IntakeAgentResult["action"] {
  if (channel === "email" || channel === "email_sim") return "extract_email";
  if (channel === "whatsapp" || channel === "whatsapp_sim") return "extract_whatsapp";
  return "skip_unsupported_channel";
}

/**
 * How long a WhatsApp conversation stays open to new messages.
 *
 * A phone number is forever, and it is the only thing tying a WhatsApp message
 * to a case — email has the Message-ID and the thread, this has a number. With
 * no bound, a message sent months later joined whatever claim was still open:
 * a fresh crash arrived as a follow-up, and the agent asked only for the one
 * document missing from the previous one.
 *
 * A week is the judgement call. A reply the next day is almost certainly the
 * same conversation; a message in March is a new accident.
 */
const WHATSAPP_THREAD_WINDOW_DAYS = 7;

async function findExistingWhatsAppCase(
  tenantId: string,
  threadId: string,
  channel: "whatsapp" | "whatsapp_sim" = "whatsapp"
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
            eq(c.channel, channel),
            eq(c.email_thread_id, threadId),
            sql`coalesce(${c.updated_at}, ${c.created_at}) > now() - interval '${sql.raw(String(WHATSAPP_THREAD_WINDOW_DAYS))} days'`,
            // Only statuses where the conversation is genuinely still open.
            //
            // `listo_para_core` and `listo` used to be here, and they are the
            // reason a finished claim swallowed the next message from that
            // number: the case is complete and waiting on the insurer, not on
            // the person. Their next message is new information at best and a
            // new accident at worst — either way it deserves its own case.
            //
            // `requiere_especialista` stays out for the same reason: a human
            // owns it, and the agent has already said it will not write again.
            inArray(c.status, ["recibido", "info_faltante", "confirmacion_pendiente"])
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
  threadId: string,
  channel: "whatsapp" | "whatsapp_sim" = "whatsapp"
): Promise<string> {
  let data: { id: string } | null;
  try {
    data = firstRow(
      await db
        .insert(tables.cases)
        .values({
          tenant_id: tenantId,
          channel,
          status: "recibido",
          email_thread_id: threadId,
          // Unknown until the extractor decides — see the same fix in gmail-poller.
          is_claim: null,
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
): Promise<string | null> {
  const now = new Date().toISOString();
  let claimMessageId: string | null = null;

  try {
    const inserted = firstRow(
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
    }).returning({ id: tables.claimMessages.id })
    );
    claimMessageId = inserted?.id ?? null;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    // 23505: this exact provider message was already stored. Attachments were
    // handled on the first pass; returning null keeps the second from
    // re-uploading them.
    if (code === "23505") return null;
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

  return claimMessageId;
}
