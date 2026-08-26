/**
 * One brain, two mouths.
 *
 * The post-extraction orchestrator decides what to say — escalate, ask for
 * what is missing, close the case — and for a long time it could only say it
 * by email. WhatsApp had its own parallel logic in server/whatsapp/notify.ts,
 * which is how the two channels drifted: every fix to the decision tree had to
 * be made twice and, in practice, was not. WhatsApp spent months acknowledging
 * a reported fire with a routine receipt, and answering follow-up messages
 * with nothing at all.
 *
 * A messenger takes the orchestrator's decision and delivers it in the shape
 * its channel expects. Deciding stays in one place; wording and transport are
 * what differ.
 *
 * Nothing here throws. A claim that was extracted and stored must not be lost
 * because we could not tell the claimant about it.
 */

import "server-only";

import { db } from "@/lib/db";
import { outboundMessages } from "@/lib/db/schema";
import { labelForField, labelForClaimType, displayFieldValue } from "@/lib/labels/claim-fields";
import { dispatchOutboundEmail } from "@/server/email/dispatch";
import type { EmailTemplate } from "@/server/email/render";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";
import { composeReply, type ReplyIntent } from "@/server/ai/compose-reply";
import { isReservedTestNumber } from "@/lib/phone/reserved";
import { enTenant } from "@/data/scope";

export interface AgentMessage {
  caseId: string;
  tenantId: string;
  /** The claimant's most recent message — used only to pitch the tone. */
  lastMessage?: string;
  /** Email address, or a wa_id — digits only, no '+'. */
  to: string;
  template: EmailTemplate;
  data: Record<string, unknown>;
  inReplyToMessageId?: string;
}

export interface AgentMessenger {
  send(message: AgentMessage): Promise<void>;
}

/** Email: the templates in server/email/templates own the wording. */
export const emailMessenger: AgentMessenger = {
  async send(message) {
    await dispatchOutboundEmail(message);
  },
};

// ── WhatsApp ──────────────────────────────────────────────────────────────────

/**
 * How many items one message may list.
 *
 * The orchestrator already caps its ask list, but a WhatsApp message is read
 * on a phone, usually one-handed, often by someone who has just crashed their
 * car. A real extraction once produced thirteen gaps; a list that long gets no
 * reply at all.
 */
const MAX_WHATSAPP_ITEMS = 5;

const ESCALATION_TEXT =
  "Recibimos tu denuncia y ya quedó registrada. Por las características de lo que nos contás, " +
  "la derivamos a un especialista que se va a comunicar con vos a la brevedad. " +
  "Si necesitás asistencia urgente, llamá a la línea de emergencias de tu póliza.";

/**
 * The "we need a few things" message.
 *
 * Facts and documents are asked for separately, and each in the verb that
 * fits: a first version told someone to send their phone number "como foto o
 * archivo", which is the same kind of tell as printing a raw database key.
 */
function renderAsk(data: Record<string, unknown>): string {
  const fields = Array.isArray(data.missingFields)
    ? (data.missingFields as string[]).map(String)
    : [];
  const known = (data.knownValues ?? {}) as Record<string, string>;

  const shown = fields.slice(0, MAX_WHATSAPP_ITEMS);
  const remaining = fields.length - shown.length;

  const items = shown.map((key) => {
    const field = labelForField(key);
    const raw = known[key]?.trim();
    // Through the same translator the email templates use: a claim type of
    // `other` has no readable form and must never reach a claimant.
    const value = raw ? displayFieldValue(key, raw)?.trim() : undefined;
    return {
      label: field.label,
      kind: field.kind,
      value,
    };
  });

  const datos = items.filter((i) => i.kind === "dato");
  const documentos = items.filter((i) => i.kind === "documento");

  const bullet = (i: (typeof items)[number]) =>
    i.value ? `• ${i.label}: entendimos "${i.value}"` : `• ${i.label}`;

  const lead = remaining > 0 ? "Para empezar, necesitamos" : "Necesitamos";

  const blocks: string[] = [];
  if (datos.length > 0) {
    blocks.push(`${lead} que nos cuentes:\n\n${datos.map(bullet).join("\n")}`);
  }
  if (documentos.length > 0) {
    blocks.push(
      datos.length > 0
        ? `Y que nos mandes:\n\n${documentos.map(bullet).join("\n")}`
        : `${lead} que nos mandes:\n\n${documentos.map(bullet).join("\n")}`
    );
  }

  const anyKnown = items.some((i) => i.value);
  const how = [
    documentos.length > 0
      ? "Podés responder por acá mismo; las fotos o archivos mandalos por este chat."
      : "Podés responder por acá mismo.",
    anyKnown ? "Si algo de lo que entendimos no es correcto, decinos el dato bien." : "",
    remaining > 0 ? "Después te pedimos el resto." : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `Recibimos tu denuncia y ya quedó registrada.\n\n${blocks.join("\n\n")}\n\n${how}`;
}

/** The conflict case: what they told us differs from what we have on file. */
function renderConflict(data: Record<string, unknown>): string {
  const fieldKey = String(data.fieldKey ?? "");
  const label = labelForField(fieldKey).label;
  const proposed = String(data.proposedValue ?? "").trim();
  const stored = String(data.conflictWithValue ?? "").trim();

  if (proposed && stored) {
    return (
      `Recibimos tu denuncia. Hay un dato que no coincide con lo que tenemos registrado.\n\n` +
      `${label}: vos nos decís "${proposed}" y en nuestro sistema figura "${stored}".\n\n` +
      `¿Cuál es el correcto? Respondé por acá y seguimos.`
    );
  }

  return `Recibimos tu denuncia. Necesitamos que nos confirmes un dato: ${label}. Respondé por acá y seguimos.`;
}

/** Nothing left to ask: an acknowledgement, or a closing if we already spoke. */
function renderClosing(data: Record<string, unknown>): string {
  const claimLabel = labelForClaimType(
    typeof data.claimType === "string" ? data.claimType : null
  );
  const phrase = claimLabel ? ` de ${claimLabel}` : "";

  return data.isFollowUp === true
    ? `Listo, ya tenemos todo lo que necesitábamos. Tu denuncia${phrase} quedó completa y pasa a análisis. ` +
        `Un analista la va a revisar y te contactamos si hiciera falta algo más.`
    : `Recibimos tu denuncia${phrase} y ya quedó registrada con todos los datos necesarios. ` +
        `Un analista la va a revisar y te contactamos si hace falta algo más.`;
}

/**
 * El piso del acuse de recibo, sin la lista de lo que falta.
 *
 * Dos oraciones: que lo anotamos, y que seguimos esperando lo de antes. Si el
 * redactor no puede mejorarlo, esto es lo que sale — y dicho así ya es
 * suficiente. Lo que no puede hacer, ni acá ni en la versión redactada, es
 * volver a enumerar lo que pedimos hace un minuto.
 */
function renderNoted(data: Record<string, unknown>): string {
  const noted = typeof data.noted === "string" && data.noted ? ` de ${data.noted}` : " de lo que nos contaste";
  return (
    `Gracias, tomamos nota${noted}. ` +
    "Seguimos a la espera de lo que te pedimos antes para poder avanzar."
  );
}

/** Which kind of message this is, for the composer's brief. */
function intentFor(template: EmailTemplate): ReplyIntent {
  switch (template) {
    case "specialist_escalation":
      return "escalation";
    case "missing_information_request":
      return "ask";
    case "data_confirmation_request":
      return "conflict";
    case "information_received":
      return "acknowledgement";
    default:
      return "closing";
  }
}

function renderForWhatsApp(message: AgentMessage): string | null {
  switch (message.template) {
    case "specialist_escalation":
      return ESCALATION_TEXT;
    case "missing_information_request":
      return renderAsk(message.data);
    case "data_confirmation_request":
      return renderConflict(message.data);
    case "information_received":
      return renderNoted(message.data);
    case "confirmation_received":
      return renderClosing(message.data);
    default:
      return null;
  }
}

/** Ledger names, so a WhatsApp row is recognisable next to an email one. */
const WHATSAPP_TEMPLATE_NAMES: Record<string, string> = {
  specialist_escalation: "wa_specialist_escalation",
  information_received: "wa_information_received",
  missing_information_request: "wa_missing_information_request",
  data_confirmation_request: "wa_data_confirmation_request",
  confirmation_received: "wa_confirmation_received",
};

/**
 * Turn the deterministic template into the message a person reads.
 *
 * The template is the floor: composeReply is asked to say the same thing
 * better, and anything failing its guardrails comes back as the template
 * unchanged. Shared by the real messenger and the simulated one so a rehearsal
 * exercises the same writer as production.
 */
async function writeWhatsAppReply(message: AgentMessage, fallback: string): Promise<string> {
  return composeReply({
    intent: intentFor(message.template),
    channel: "whatsapp",
    fields: Array.isArray(message.data.missingFields)
      ? (message.data.missingFields as string[]).map(String)
      : undefined,
    knownValues: (message.data.knownValues ?? undefined) as
      | Record<string, string>
      | undefined,
    claimTypeLabel: labelForClaimType(
      typeof message.data.claimType === "string" ? message.data.claimType : null
    ),
    isFollowUp: message.data.isFollowUp === true,
    claimantName:
      typeof message.data.claimantName === "string" ? message.data.claimantName : null,
    question: typeof message.data.question === "string" ? message.data.question : null,
    lastMessage: message.lastMessage,
    fallback,
  });
}

export const whatsappMessenger: AgentMessenger = {
  async send(message) {
    try {
      // Un asegurado inventado no recibe nada, entre por donde entre.
      //
      // La restricción estaba en el mensajero simulado, que alcanza mientras
      // inventar un asegurado sea cosa del camino simulado. Una prueba que
      // entra por el webhook firmado usa ESTE mensajero, y el intento de envío
      // saldría hacia Meta — que es de las cosas por las que restringen una
      // cuenta de WhatsApp Business. La prueba que sirve para no romper
      // producción no puede ser la que nos bloquee el canal.
      if (isReservedTestNumber(message.to)) {
        await simulatedWhatsappMessenger.send(message);
        return;
      }

      const body = renderForWhatsApp(message);
      if (!body) {
        console.error(
          JSON.stringify({
            level: "error",
            service: "claimmix",
            msg: "whatsapp.messenger.no_renderer",
            case_id: message.caseId,
            template: message.template,
          })
        );
        return;
      }

      const finalBody = await writeWhatsAppReply(message, body);

      const res = await sendWhatsAppText(message.to, finalBody);
      await recordOutbound(message, finalBody, res.ok ? "sent" : "failed");

      console.log(
        JSON.stringify({
          level: res.ok ? "info" : "error",
          service: "claimmix",
          msg: res.ok ? "whatsapp.messenger.sent" : "whatsapp.messenger.send_failed",
          case_id: message.caseId,
          template: message.template,
        })
      );
    } catch (err) {
      // Intake already succeeded; a messaging failure must not undo it.
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "whatsapp.messenger.error",
          case_id: message.caseId,
          error: err instanceof Error ? err.name : "UnknownError",
        })
      );
    }
  },
};

/** Best-effort ledger write, in the same table email writes to. */
async function recordOutbound(
  message: AgentMessage,
  body: string,
  status: "sent" | "failed" | "skipped_simulated"
): Promise<void> {
  try {
    await enTenant({ tenantId: message.tenantId }, (db) =>
      db.insert(outboundMessages).values({
        case_id: message.caseId,
        tenant_id: message.tenantId,
        channel: "whatsapp",
        template: WHATSAPP_TEMPLATE_NAMES[message.template] ?? message.template,
        rendered_body: body,
        status,
        asked_keys: Array.isArray(message.data.missingFields)
          ? (message.data.missingFields as unknown[]).map(String)
          : null,
      })
    );
  } catch (err) {
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "DBError");
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "whatsapp.messenger.ledger_failed",
        case_id: message.caseId,
        code,
      })
    );
  }
}

/**
 * Records what it would have said, and sends nothing.
 *
 * The simulation and BSP paths invent phone numbers. Answering used to be the
 * route's job and that path simply never asked for a reply; now the
 * orchestrator answers every case, so the restraint has to live here. Email
 * has the same guard against IANA-reserved example.* addresses.
 */
export const simulatedWhatsappMessenger: AgentMessenger = {
  async send(message) {
    const body = renderForWhatsApp(message);
    if (!body) return;
    // Compose, then do not send. A rehearsal that skipped the writer would be
    // rehearsing a different script: the template is the floor, and what a
    // claimant actually reads is whatever the model made of it.
    const finalBody = await writeWhatsAppReply(message, body);
    await recordOutbound(message, finalBody, "skipped_simulated");
    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "whatsapp.messenger.skipped_simulated",
        case_id: message.caseId,
        template: message.template,
      })
    );
  },
};

/** The messenger for a case's channel. */
export function messengerFor(channel: string): AgentMessenger {
  if (channel === "whatsapp_sim") return simulatedWhatsappMessenger;
  if (channel === "whatsapp") return whatsappMessenger;
  return emailMessenger;
}
