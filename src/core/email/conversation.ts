import { diaArgentino } from "@/core/fecha/dia-argentino";
/**
 * De una conversación de correo al texto que lee el extractor.
 *
 * Está en `src/core/` porque no habla con nadie: entra texto, sale texto. Eso
 * lo vuelve probable sin base de datos, sin red y sin reloj — y estas cuatro
 * funciones son justamente las que más casos raros tienen (respuestas citadas,
 * fechas relativas, conversaciones que no entran en el tope).
 *
 * Vivían adentro de `extract.ts`, entre mil seiscientas líneas que sí hablan
 * con la base. Nada las obligaba a estar ahí.
 */

/**
 * When each message arrived, so relative dates resolve against the right day.
 *
 * "Choqué ayer" was extracted as the day before the message on the first run
 * and, two days later, as the day before *that* run: the whole conversation is
 * re-read on every reply, and with no dates in it the model anchored on today.
 * The accident silently moved. Stamping each message pins the anchor to the
 * moment it was actually sent.
 */
export function dateSuffix(receivedAt: string | null): string {
  if (!receivedAt) return "";
  const at = new Date(receivedAt);
  if (Number.isNaN(at.getTime())) return "";
  // El día ACÁ, no en UTC: un mensaje de las 22:10 se mostraba con la fecha de
  // mañana, y esa fecha la lee el modelo para decidir.
  return ` — recibido el ${diaArgentino(at)}`;
}

/** El mismo sello para un mensaje suelto, que no lleva encabezado de bloque. */
export function stampDate(body: string, receivedAt: string | null): string {
  const suffix = dateSuffix(receivedAt);
  return suffix ? `[Mensaje${suffix}]\n${body}` : body;
}


/** Per-message cap. Long enough for any real claim, short enough to bound cost. */
const MAX_CHARS_PER_MESSAGE = 4_000;
/** Whole-conversation cap. */
const MAX_CONVERSATION_CHARS = 16_000;

/**
 * Strip the quoted copy of earlier mail a reply carries.
 *
 * A claimant's reply usually quotes the message it answers, which for us means
 * our own template comes back in. That is the same poisoning as ingesting our
 * sent mail, arriving by a different door: the extractor reads "necesitamos que
 * nos proporciones la siguiente información" as though the claimant wrote it.
 * Quoted lines and the attribution line that introduces them go.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    // "El lun, 18 ago 2026 a las 21:31, X escribió:" / "On Mon, ... wrote:"
    if (/^\s*(el|on)\b.{0,120}\b(escribi[oó]|wrote):\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(mensaje original|original message)\s*-{2,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

/**
 * Render every inbound message as one document for the extractor.
 *
 * Oldest first, so facts stated once at the start survive into every later
 * analysis. Newest messages are kept whole when the cap bites — a claimant
 * correcting themselves means the last word wins.
 */
export function buildConversationBody(
  messages: Array<{ body_text: string | null; received_at: string | null }>
): string {
  const cleaned = messages
    .map((m) => ({
      body: stripQuotedReply(m.body_text ?? "").slice(0, MAX_CHARS_PER_MESSAGE),
      receivedAt: m.received_at,
    }))
    .filter((m) => m.body.length > 0);

  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return stampDate(cleaned[0].body, cleaned[0].receivedAt);

  const blocks = cleaned.map(
    (m, i) =>
      `[Mensaje ${i + 1} de ${cleaned.length}${dateSuffix(m.receivedAt)}]\n${m.body}`
  );

  // Drop from the middle if it does not fit: the first message states the
  // claim, the last ones answer our questions, and the middle is the most
  // likely to be repetition.
  while (blocks.length > 2 && blocks.join("\n\n").length > MAX_CONVERSATION_CHARS) {
    blocks.splice(1, 1);
  }

  return blocks.join("\n\n");
}
