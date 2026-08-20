/**
 * Letting the model write the message, without letting it decide anything.
 *
 * The split matters. The orchestrator decides WHAT to say — escalate, ask for
 * these four fields, close the case — from rules that are auditable and the
 * same every time. This module decides only HOW to say it, and every claim it
 * could invent is checked before the words reach a person.
 *
 * The model was already drafting a reply on every extraction, in the
 * `suggested_reply` field, and we threw it away and answered with a template.
 * That is why an agent handling a fire and an agent handling a scratched
 * bumper sounded identical.
 *
 * A template is the floor, not the ceiling: anything the guardrails reject
 * falls back to the hand-written version, which is always correct if plain.
 * A missing key, a slow call, a refusal — all land on the same floor.
 */

import "server-only";

import { callGemini } from "@/server/ai/gemini-extractor";
import { labelForField } from "@/lib/labels/claim-fields";

export type ReplyIntent =
  | "ask" // we need things from them
  | "escalation" // a specialist is taking over
  | "closing" // nothing left to ask
  | "conflict"; // what they said differs from what we hold

export interface ComposeReplyInput {
  intent: ReplyIntent;
  channel: "email" | "whatsapp";
  /** Field keys we are asking about, in the order the orchestrator chose. */
  fields?: string[];
  /** Values we already hold for some of those fields. */
  knownValues?: Record<string, string>;
  /** Spanish name of the claim type, when we know it. */
  claimTypeLabel?: string | null;
  /** True when we have already written to this claimant about this case. */
  isFollowUp?: boolean;
  /**
   * The claimant's name, when the claim already holds one.
   *
   * Not derived from `lastMessage`: a person who introduces themselves in the
   * first message and then sends a photo with no caption was greeted with a
   * bare "¡Hola!" on the second round, because the only text the composer
   * saw was "[Imagen adjunta sin texto]".
   */
  claimantName?: string | null;
  /** The claimant's most recent message, for tone only. */
  lastMessage?: string;
  /** The deterministic text. The model is asked to do better, not different. */
  fallback: string;
}

/**
 * Phrases a claims agent must never produce.
 *
 * Not a content filter — a liability one. An insurer that says "está cubierto"
 * or "te depositamos en 48 horas" in an automated message has made a promise
 * before anyone assessed the claim. The rules engine cannot know coverage, so
 * neither can the sentence describing it.
 */
const FORBIDDEN = [
  /\bcubiert[oa]s?\b/i,
  /\bcobertura (?:confirmada|aprobada|garantizada)\b/i,
  /\baprobad[oa]s?\b/i,
  /\brechazad[oa]s?\b/i,
  /\bindemniza/i,
  /\bte (?:vamos a )?(?:pag|deposit|transferir|reintegr)/i,
  /\ble (?:vamos a )?(?:pag|deposit|transferir|reintegr)/i,
  /\b(?:pesos|d[óo]lares|usd|ars|\$)\s*\d/i,
  /\bfranquicia de\b/i,
  /\ben (?:un plazo de )?\d+\s*(?:horas?|d[íi]as?|semanas?)\b/i,
  /\bgrúa\b/i, // dispatching a tow truck is an operation, not a sentence
  /\bturno\b/i,
];

/** Bounds. A chat message read one-handed, an email read at a desk. */
const MAX_CHARS: Record<ComposeReplyInput["channel"], number> = {
  whatsapp: 700,
  email: 1400,
};

function buildPrompt(input: ComposeReplyInput): string {
  const items = (input.fields ?? []).map((key) => {
    const { label, instruction, kind } = labelForField(key);
    const known = input.knownValues?.[key];
    return known
      ? `- ${label} (ya entendimos "${known}", pedir corrección sólo si no es correcto)`
      : `- ${label} — ${instruction} (${kind === "documento" ? "archivo o foto" : "dato"})`;
  });

  const intentBrief: Record<ReplyIntent, string> = {
    ask: "Pedir los datos listados. No pidas nada que no esté en la lista.",
    escalation:
      "Avisar que la denuncia se derivó a un especialista que se va a comunicar a la brevedad, " +
      "y que si necesita asistencia urgente llame a la línea de emergencias de su póliza. " +
      "NO pidas ningún dato: un especialista se encarga.",
    closing:
      "Avisar que ya tenemos todo lo necesario y que la denuncia pasa a análisis. NO pidas nada.",
    conflict: "Señalar la diferencia entre los dos valores y preguntar cuál es el correcto.",
  };

  const channelBrief =
    input.channel === "whatsapp"
      ? "Es un mensaje de WhatsApp: se lee en un teléfono, con una mano. Corto, sin encabezados, " +
        "sin firma, sin asunto. Si hay lista, viñetas con •."
      : "Es el cuerpo de un email: párrafos cortos. Sin saludo con nombre, sin firma, sin asunto. " +
        "Si hay lista, una línea por ítem empezando con '- '.";

  return `Sos quien redacta los mensajes de una aseguradora argentina a una persona que acaba de
denunciar un siniestro. Escribís en castellano rioplatense, con voseo, claro y humano.

LO QUE HAY QUE DECIR (no lo cambies, no agregues ni saques temas):
${intentBrief[input.intent]}

${items.length > 0 ? `DATOS A PEDIR:\n${items.join("\n")}` : ""}
${input.claimTypeLabel ? `\nTipo de siniestro: ${input.claimTypeLabel}` : ""}
${input.claimantName ? `\nLa persona se llama ${input.claimantName}. Podés llamarla por su nombre de pila.` : ""}
${input.isFollowUp ? "\nYa venimos conversando con esta persona: no la saludes como si fuera el primer contacto." : "\nEs el primer mensaje que le mandamos."}
${input.lastMessage ? `\nÚLTIMO MENSAJE DE LA PERSONA (sólo para ajustar el tono, no lo respondas punto por punto):\n"""${input.lastMessage.slice(0, 600)}"""` : ""}

${channelBrief}

PROHIBIDO, sin excepción:
- Prometer cobertura, pagos, montos, plazos, reintegros, grúas o turnos. Nadie evaluó el siniestro todavía.
- Decir que algo está aprobado, cubierto o rechazado.
- Inventar datos, números de caso, nombres o fechas que no estén acá arriba.
- Pedir algo que no esté en la lista de datos.
- Disculpas largas, floreo, o tono de robot.

TONO: si lo que contó es grave —fuego, heridos, robo— sé sobrio y breve. Si es un
choque menor, sé cordial y directo. Nunca dramatices ni minimices.

Devolvé JSON: {"message": "<el texto del mensaje>"}`;
}

/** Everything the guardrails check, in one place so a rejection is explainable. */
function violation(text: string, input: ComposeReplyInput): string | null {
  const trimmed = text.trim();

  if (trimmed.length < 20) return "too_short";
  if (trimmed.length > MAX_CHARS[input.channel]) return "too_long";

  for (const pattern of FORBIDDEN) {
    if (pattern.test(trimmed)) return `forbidden:${pattern.source.slice(0, 24)}`;
  }

  // Every field we decided to ask about has to survive into the message. The
  // model rewording "DNI del titular" is fine; dropping it is the orchestrator
  // asking for four things and the claimant seeing three.
  if (input.intent === "ask") {
    for (const key of input.fields ?? []) {
      const { label } = labelForField(key);
      const head = label.split(" ")[0].toLowerCase();
      if (!trimmed.toLowerCase().includes(head)) return `dropped_field:${key}`;
    }
  }

  // An escalation that asks for something contradicts itself — that exact
  // pile-up is why escalated cases send one message and nothing else.
  if (input.intent === "escalation" && /necesitamos que nos|envianos|mandanos/i.test(trimmed)) {
    return "escalation_asks_for_data";
  }

  return null;
}

/**
 * Write the message. Returns the fallback whenever anything is off.
 *
 * Never throws and never blocks: composition failing means the claimant gets
 * the plain version, which is the same message in duller words.
 */
export async function composeReply(input: ComposeReplyInput): Promise<string> {
  if (process.env.AGENT_COMPOSE_REPLIES === "off") return input.fallback;

  try {
    const { text } = await callGemini(
      buildPrompt(input),
      "Escribí el mensaje y devolvelo como JSON."
    );
    if (!text) return input.fallback;

    const parsed = JSON.parse(text) as { message?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    if (!message) return input.fallback;

    const problem = violation(message, input);
    if (problem) {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "claimmix",
          msg: "compose.rejected",
          intent: input.intent,
          channel: input.channel,
          reason: problem,
        })
      );
      return input.fallback;
    }

    return message;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "compose.failed",
        intent: input.intent,
        error: err instanceof Error ? err.name : "UnknownError",
      })
    );
    return input.fallback;
  }
}
