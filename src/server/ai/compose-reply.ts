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
  | "conflict" // what they said differs from what we hold
  | "acknowledgement"; // they told us something; what we need has not changed

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
  /**
   * A question the claimant asked that this message has to answer.
   *
   * The agent could only ever collect. Someone who wrote "¿cuánto tarda? lo
   * necesito para trabajar" got the next document request and nothing else,
   * which is the single most robotic thing it did. What can honestly be said
   * is bounded by the same guardrails as everything else — no timelines, no
   * coverage, nothing invented — but saying nothing was never the honest
   * option, only the easy one.
   */
  question?: string | null;
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

/** Answering a question and asking for things needs more room than either alone. */
function maxChars(input: ComposeReplyInput): number {
  const base = MAX_CHARS[input.channel];
  return input.question ? Math.round(base * 1.4) : base;
}

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
    // Es la única intención donde la lista de campos se pasa para que NO se
    // use: el redactor la necesita para no volver a pedir eso mismo con
    // otras palabras, que es como se rompería la regla sin darse cuenta.
    // La lista de campos NO se le muestra a esta intención, aunque llegue: ver
    // el bloque DATOS A PEDIR más abajo. Una lista en el prompt se lee como
    // una lista de cosas para pedir por más que la instrucción diga lo
    // contrario — pasó, y salió el mismo pedido con otras palabras.
    acknowledgement:
      "Decir que tomamos nota de lo que la persona acaba de contar, y que seguimos " +
      "esperando lo que ya le pedimos. NO repitas la lista de datos: se la pedimos hace " +
      "un momento y repetirla es hostigar. NO digas que está todo completo, porque no lo " +
      "está. Dos oraciones como mucho.",
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

${items.length > 0 && input.intent !== "acknowledgement" ? `DATOS A PEDIR:\n${items.join("\n")}` : ""}
${input.claimTypeLabel ? `\nTipo de siniestro: ${input.claimTypeLabel}` : ""}
${input.claimantName ? `\nLa persona se llama ${input.claimantName}. Podés llamarla por su nombre de pila.` : ""}
${input.question ? `\nLA PERSONA PREGUNTÓ ESTO Y HAY QUE CONTESTARLE:\n"${input.question}"\nContestá con lo que sabemos de verdad: en qué estado está su denuncia y qué falta para avanzar. Si no lo sabemos — cuánto tarda, cuánto le van a pagar, si está cubierto — decilo con honestidad y sin inventar plazos ni montos. Nunca dejes la pregunta sin responder.` : ""}
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
  if (trimmed.length > maxChars(input)) return "too_long";

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

/** Either a message that passed every guardrail, or why it did not. */
type Attempt = { ok: true; message: string } | { ok: false; problem: string };

/**
 * One pass at the message.
 *
 * The two outcomes are both strings and must not be confused: returning the
 * rejection reason as the message would send the claimant the word
 * "dropped_field:policy_number".
 */
async function attempt(
  input: ComposeReplyInput,
  previousProblem?: string
): Promise<Attempt> {
  const correction = previousProblem
    ? `

Tu intento anterior fue rechazado por: ${explain(previousProblem)}
Corregilo y devolvé el mensaje entero de nuevo.`
    : "";

  const { text } = await callGemini(
    buildPrompt(input) + correction,
    "Escribí el mensaje y devolvelo como JSON."
  );
  if (!text) return { ok: false, problem: "no_output" };

  const parsed = JSON.parse(text) as { message?: unknown };
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  if (!message) return { ok: false, problem: "empty_message" };

  const problem = violation(message, input);
  return problem ? { ok: false, problem } : { ok: true, message };
}

/** The rejection, in words the model can act on. */
function explain(problem: string): string {
  if (problem.startsWith("dropped_field:")) {
    const key = problem.slice("dropped_field:".length);
    return `te olvidaste de pedir "${labelForField(key).label}". Tienen que estar TODOS los ítems de la lista.`;
  }
  if (problem.startsWith("forbidden:")) {
    return "prometiste algo sobre cobertura, pagos o plazos. Nadie evaluó el siniestro todavía.";
  }
  if (problem === "too_long") return "es demasiado largo. Cortálo.";
  if (problem === "too_short") return "es demasiado corto.";
  if (problem === "escalation_asks_for_data") {
    return "pediste datos en un mensaje de derivación. No hay que pedir nada: se encarga un especialista.";
  }
  return problem;
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
    const first = await attempt(input);
    if (first.ok) return first.message;

    // One more go, told exactly what was wrong.
    //
    // Rehearsals showed the common rejection is `dropped_field`: asked for
    // five things, the model listed four. That is a slip worth correcting, not
    // a reason to fall back to the template — which is how a claim ended up
    // reading like a form letter when the writer was one bullet away from a
    // good message. Anything still wrong on the second pass gets the template.
    const second = await attempt(input, first.problem);
    if (second.ok) return second.message;

    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "compose.rejected",
        intent: input.intent,
        channel: input.channel,
        reason: second.problem,
        first_reason: first.problem,
      })
    );
    return withUnansweredQuestion(input);
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
    return withUnansweredQuestion(input);
  }
}

/**
 * The template, plus a plain answer when a question would otherwise hang.
 *
 * Falling back to the template is fine for tone and fatal for a question: the
 * claimant asked "¿cuánto tarda? lo necesito para trabajar" and received a
 * paragraph about their claim passing to analysis, which reads as being
 * ignored. And composition fails most often precisely here — answering a
 * question is where the model reaches for coverage and timing, which is
 * exactly what the guardrails refuse.
 *
 * So the honest sentence is written by hand. It promises nothing, because
 * there is nothing anyone can promise before a person has looked at the claim,
 * but it does not pretend the question was not asked.
 */
function withUnansweredQuestion(input: ComposeReplyInput): string {
  if (!input.question) return input.fallback;
  const honest =
    "Sobre lo que preguntás: todavía no podemos darte una respuesta, porque " +
    "nadie revisó tu caso aún. En cuanto un analista lo mire te avisamos por acá.";
  return `${input.fallback}\n\n${honest}`;
}
