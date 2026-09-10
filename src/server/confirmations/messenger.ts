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
import {
  maskDni,
  maskPolicyNumber,
  renderTemplate,
  type EmailTemplate,
} from "@/server/email/render";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";
import { composeReply, type ReplyIntent } from "@/server/ai/compose-reply";
import { isReservedTestNumber } from "@/core/phone/reserved";
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

/**
 * Email: the template is the floor here too.
 *
 * It was not: `emailMessenger` handed the message straight to the dispatcher,
 * so a claimant read the deterministic HTML verbatim while a WhatsApp claimant
 * read something a person could have written. Same brain, two products.
 *
 * The composition happens HERE and not inside `dispatch`, and that is the whole
 * design. Dispatch builds the mail twice — the preview it records for a
 * reserved test address, and the real send — and both call the same
 * `renderTemplate(template, data)`. Sending the written prose inside `data`
 * means the two get the same string by construction, not because someone
 * remembered to change both. The rehearsal reads the first; a claimant reads
 * the second.
 *
 * The fallback handed to the writer is `piso.cuerpo`, never `piso.text`: the
 * whole document would have the model rewriting the footer and the reference
 * line, spending the 1400-character budget on chrome and collecting `too_long`
 * rejections for no real reason.
 *
 * And when the writer gives back exactly the floor — switch off, two
 * rejections, an exception — nothing is passed at all, so the output is byte
 * for byte what it was before this existed.
 */
export const emailMessenger: AgentMessenger = {
  async send(message) {
    let cuerpo: string | null = null;
    try {
      const piso = renderTemplate(message.template, message.data);
      const prosa = await writeReply(message, piso.cuerpo, "email");
      if (prosa !== piso.cuerpo) cuerpo = prosa;
    } catch (err) {
      // Este módulo promete que nada acá tira: una denuncia ya extraída y
      // guardada no se puede perder porque el redactor falló.
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "email.messenger.compose_failed",
          case_id: message.caseId,
          template: message.template,
          error: err instanceof Error ? err.name : "UnknownError",
        })
      );
    }

    await dispatchOutboundEmail(
      cuerpo === null ? message : { ...message, data: { ...message.data, cuerpo } }
    );
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

/**
 * El caso de conflicto: lo que nos dijeron no coincide con lo que tenemos.
 *
 * Acepta varios datos porque le llegan varios: cuando escribe un familiar del
 * titular no coincide el nombre, ni el mail, ni el documento. Antes salía un
 * mensaje de WhatsApp por cada uno.
 */
function renderConflict(data: Record<string, unknown>): string {
  const campos = camposDeConflicto(data);

  const conValor = campos.filter((c) => c.proposed && c.stored);
  if (conValor.length === 0) {
    const etiquetas = campos.map((c) => labelForField(c.fieldKey).label);
    return etiquetas.length > 0
      ? `Recibimos tu denuncia. Necesitamos que nos confirmes ${etiquetas.length > 1 ? "estos datos" : "un dato"}: ${listar(etiquetas)}. Respondé por acá y seguimos.`
      : `Recibimos tu denuncia. Necesitamos que nos confirmes un dato. Respondé por acá y seguimos.`;
  }

  const lineas = conValor.map((c) => {
    const label = labelForField(c.fieldKey).label;
    // Enmascarado, igual que lo que entra al prompt: éste es el texto que sale
    // por WhatsApp cuando el redactor no está, y salía con el DNI entero.
    const propuesto = enmascarar(c.fieldKey, c.proposed);
    const guardado = enmascarar(c.fieldKey, c.stored);
    return `${label}: vos nos decís "${propuesto}" y en nuestro sistema figura "${guardado}".`;
  });

  const encabezado =
    lineas.length > 1
      ? "Recibimos tu denuncia. Hay algunos datos que no coinciden con lo que tenemos registrado."
      : "Recibimos tu denuncia. Hay un dato que no coincide con lo que tenemos registrado.";

  const cierre =
    lineas.length > 1
      ? "¿Cuáles son los correctos? Respondé por acá y seguimos."
      : "¿Cuál es el correcto? Respondé por acá y seguimos.";

  return [encabezado, lineas.join("\n"), cierre].join("\n\n");
}

/** Los campos del mensaje, venga la lista nueva o un campo suelto. */
function camposDeConflicto(
  data: Record<string, unknown>
): Array<{ fieldKey: string; proposed: string; stored: string }> {
  const lista = Array.isArray(data.fields) ? data.fields : null;
  const crudos = lista?.length
    ? (lista as Array<Record<string, unknown>>)
    : [data];

  return crudos
    .map((c) => ({
      fieldKey: String(c.fieldKey ?? ""),
      proposed: String(c.proposedValue ?? "").trim(),
      stored: String(c.conflictWithValue ?? "").trim(),
    }))
    .filter((c) => c.fieldKey);
}

/** «a, b y c» — que se lea como lo escribiría una persona. */
function listar(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
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
 *
 * (Leía un `data.noted` que nadie seteó nunca — el detalle que se iba a
 * nombrar—, declarado igual en los dos canales. Un parámetro muerto en dos
 * escritores es cómo el próximo lo «pasa» y no cambia nada.)
 */
function renderNoted(): string {
  return (
    "Gracias, tomamos nota de lo que nos contaste. " +
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
      return renderNoted();
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
 * Cómo se llama esta plantilla en el libro, en todos los canales.
 *
 * El libro no guarda el mismo nombre para los dos: el mail escribe
 * `confirmation_received` y WhatsApp `wa_confirmation_received` —el mapa de
 * acá arriba, aplicado en `recordOutbound`—. Quien pregunte «¿esto ya
 * salió?» tiene que preguntar por TODOS los nombres, y la guarda del cierre
 * preguntaba sólo por el del mail: en WhatsApp, un caso ya completo podía
 * recibir el cierre otra vez, porque la fila que lo tenía que frenar se
 * llamaba distinto.
 *
 * Vive acá y no en el orquestador a propósito: el renombre pasa en este
 * archivo, así que un canal nuevo que agregue su prefijo queda cubierto sin
 * que nadie se acuerde de ir a tocar la guarda.
 */
export function nombresEnElLibro(template: EmailTemplate): string[] {
  return [
    ...new Set<string>([template, WHATSAPP_TEMPLATE_NAMES[template] ?? template]),
  ];
}

/**
 * Turn the deterministic template into the message a person reads.
 *
 * The template is the floor: composeReply is asked to say the same thing
 * better, and anything failing its guardrails comes back as the template
 * unchanged. Shared by the real messenger and the simulated one so a rehearsal
 * exercises the same writer as production — and, since the channel is an
 * argument, by email too. Nothing below this line was ever WhatsApp-specific:
 * `intentFor` and the mapping out of `message.data` read the orchestrator's
 * decision, which is the same decision either way.
 */
/**
 * Los valores del conflicto como se los puede ver el redactor.
 *
 * Enmascarados con las mismas funciones que usa la plantilla de mail, y por
 * el mismo motivo: AC24 dice que un DNI o un número de póliza no se escriben
 * enteros. La plantilla los enmascaraba al renderizar, o sea después; desde
 * que la prosa del modelo reemplaza el cuerpo, ese enmascarado ya no está en
 * el camino y hay que hacerlo ANTES, sobre lo que entra al prompt.
 *
 * Enmascarar a la entrada y no filtrar a la salida es a propósito: un modelo
 * no puede repetir un número que nunca vio, y eso no depende de que una
 * expresión regular lo reconozca.
 *
 * Se descartan los campos sin los dos valores. Un conflicto sin el valor
 * guardado no es un conflicto — es un dato que falta — y la guarda de
 * `composeReply` no tendría con qué comparar.
 */
/**
 * Un valor sensible, como se puede escribir.
 *
 * Vivía adentro de `conflictosParaElRedactor`, o sea que sólo se aplicaba a lo
 * que entraba al prompt del modelo. `renderConflict` —el texto que se manda tal
 * cual cuando el redactor está apagado, cuando las guardas lo rechazan o cuando
 * tira excepción— interpolaba los valores en crudo, así que el DNI entero salía
 * por WhatsApp y quedaba visible en la notificación de la pantalla bloqueada.
 *
 * Es la misma regla en los dos lados, así que es una sola función.
 */
function enmascarar(fieldKey: string, valor: string): string {
  return fieldKey === "dni"
    ? maskDni(valor)
    : fieldKey === "policy_number"
      ? maskPolicyNumber(valor)
      : valor;
}

function conflictosParaElRedactor(
  data: Record<string, unknown>
): Array<{ fieldKey: string; proposed: string; stored: string }> {
  return camposDeConflicto(data)
    .filter((c) => c.proposed && c.stored)
    .map((c) => ({
      fieldKey: c.fieldKey,
      proposed: enmascarar(c.fieldKey, c.proposed),
      stored: enmascarar(c.fieldKey, c.stored),
    }));
}

async function writeReply(
  message: AgentMessage,
  fallback: string,
  channel: "email" | "whatsapp"
): Promise<string> {
  return composeReply({
    // Cubre los tres mensajeros y el ensayo: los tres pasan por acá.
    tenantId: message.tenantId,
    intent: intentFor(message.template),
    channel,
    fields: Array.isArray(message.data.missingFields)
      ? (message.data.missingFields as string[]).map(String)
      : undefined,
    conflicts:
      message.template === "data_confirmation_request"
        ? conflictosParaElRedactor(message.data)
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

      const finalBody = await writeReply(message, body, "whatsapp");

      const res = await sendWhatsAppText(message.to, finalBody);
      await recordOutbound(message, finalBody, res.ok ? "sent" : "failed");

      // Un envío fallido sale por stderr, no por stdout.
      //
      // La línea decía `level: "error"` y se iba igual por `console.log`. Quien
      // filtre por stream —que es lo que hace cualquier alerta— no lo veía: un
      // mensaje que no le llegó al asegurado quedaba con la misma prioridad que
      // uno que sí.
      const registrar = res.ok ? console.log : console.error;
      /*
       * Y el motivo, que `sendWhatsAppText` ya se tomó el trabajo de armar.
       *
       * Devuelve `{ ok: false, error: "Cloud API 400: {…}" }` con el cuerpo de
       * error de Meta adentro, y acá se descartaba. Token vencido, fuera de la
       * ventana de 24 h, plantilla sin aprobar, número fuera de la lista
       * permitida, o Meta con un 503: todos producían la misma línea.
       *
       * Es el mismo defecto que los 115 fallos de Gmail de junio, en el otro
       * canal — con el agravante de que acá el valor ya estaba en la mano.
       *
       * Recortado, porque el cuerpo de error de Meta puede traer el payload que
       * mandamos y ahí adentro va el texto del mensaje.
       */
      registrar(
        JSON.stringify({
          level: res.ok ? "info" : "error",
          service: "claimmix",
          msg: res.ok ? "whatsapp.messenger.sent" : "whatsapp.messenger.send_failed",
          case_id: message.caseId,
          template: message.template,
          ...(res.ok || !res.error ? {} : { detalle: res.error.slice(0, 200) }),
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
    const finalBody = await writeReply(message, body, "whatsapp");
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
