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

import { sinCentinelas } from "@/core/ai/sin-centinelas";
import { callGemini, errMeta } from "@/server/ai/gemini-extractor";
import { canonicalFieldKey, labelForField } from "@/lib/labels/claim-fields";
import { conRespuestaPendiente } from "@/core/mensajes/respuesta-pendiente";
import { confirmaLoQueEscribio } from "@/core/mensajes/lo-dicho";
import { CUIDADO, diceCuidado, hablaDeLaSalud, pideDatos } from "@/core/mensajes/derivacion";
import { AVISO_DE_TRASPASO, mencionaElTraspaso } from "@/core/mensajes/traspaso";
import { registrarConsumoDelModelo } from "@/server/ai/budget";
import { logger } from "@/lib/observability/logger";

export type ReplyIntent =
  | "ask" // we need things from them
  | "escalation" // a specialist is taking over
  | "closing" // nothing left to ask
  | "conflict" // what they said differs from what we hold
  | "acknowledgement"; // they told us something; what we need has not changed

export interface ComposeReplyInput {
  intent: ReplyIntent;
  channel: "email" | "whatsapp";
  /**
   * De quién es este gasto.
   *
   * Obligatorio y no opcional a propósito: un campo opcional es cómo esto
   * se pudre de vuelta —el próximo que llame lo omite, la fila desaparece y
   * no falla nada—. Requerido, lo pide el compilador.
   */
  tenantId: string;
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
  /**
   * Los datos que no coinciden, YA enmascarados.
   *
   * Sin esto la intención `conflict` era la única cuya instrucción
   * —«Señalar la diferencia entre los dos valores»— hablaba de algo que el
   * prompt no contenía. El redactor tampoco recibe `fallback`, así que no
   * tenía de dónde sacarlos: salía un párrafo diciendo que había una
   * diferencia sin decir en qué dato ni entre qué valores, y la persona se
   * quedaba sin nada que contestar con el caso trabado esperándola.
   *
   * Enmascarados porque AC24 sigue valiendo: para señalar que dos valores
   * no coinciden no hace falta un DNI entero, y lo que el modelo no ve no
   * lo puede repetir.
   */
  conflicts?: Array<{ fieldKey: string; proposed: string; stored: string }>;
  /**
   * El conflicto es con el titular de la póliza, y el caso ya se derivó.
   *
   * Los dos valores pueden ser correctos —escribe la hija por el auto del
   * padre—, así que preguntar cuál es el bueno no tiene respuesta.
   */
  titularAjeno?: boolean;
  /**
   * Alguien se lastimó: la derivación abre con la frase de cuidado.
   *
   * El booleano del orquestador y no el texto del piso: el de WhatsApp trae el
   * nombre que escribió la persona, y un «Lamentamos» ahí prendía la consigna
   * en una derivación por titular ajeno.
   */
  heridos?: boolean;
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

/**
 * El mensaje de la persona, sin los números que no hay que repetir.
 *
 * `lastMessage` entra al prompt para dar tono, y es el correo que escribió
 * un asegurado: adentro viene su DNI entero, porque se lo pedimos nosotros.
 * Mientras el cuerpo lo armó la plantilla eso no salía a ningún lado — la
 * plantilla enmascara al renderizar. Desde que la prosa del modelo reemplaza
 * el cuerpo, lo que el modelo leyó puede terminar en el mail, y AC24 pasa a
 * depender de que al modelo no se le ocurra copiarlo.
 *
 * Siete a ocho dígitos seguidos es un DNI argentino; los puntos y espacios se
 * aceptan porque así lo escribe la gente. Un año o un monto no llegan a
 * siete, y una patente lleva letras.
 */
function sinNumerosEnteros(texto: string): string {
  const ultimosCuatro = (m: string): string => {
    const digitos = m.replace(/\D/g, "");
    return digitos.length >= 7 && digitos.length <= 10
      ? "****" + digitos.slice(-4)
      : m;
  };

  return (
    texto
      // Un DNI suelto, con o sin los puntos con que lo escribe la gente.
      .replace(/\b\d[\d.\s]{5,}\d\b/g, ultimosCuatro)
      // Una póliza, que lleva prefijo de letras: POL-2024-001. La patente
      // no entra — ABC-321 no llega a seis dígitos.
      .replace(/\b([A-Za-z]{2,4})-([\d.-]{6,})\b/g, (m, pre: string, resto: string) => {
        const digitos = resto.replace(/\D/g, "");
        return digitos.length >= 6 ? `${pre}-****${digitos.slice(-4)}` : m;
      })
  );
}

/*
 * El ensayo del 23/09 abría «necesitamos que nos mandes:» y seguía con
 * «• Decinos si alguien resultó lastimado.» o «• ¿Tu nombre completo es…?»: el
 * modelo copiaba la instrucción de cada campo, con su verbo, y metía la
 * confirmación en una lista de cosas para mandar.
 */
const COMO_VA_LA_LISTA =
  "CÓMO VA LA LISTA: el verbo va una sola vez, en la frase que la abre, y después un renglón " +
  "en blanco. Cada ítem nombra lo que falta sin verbo propio —«El número de póliza (por ejemplo " +
  "POL-12345)», «Si alguien resultó lastimado», «Fotos de los daños»—, nunca «Decinos…», " +
  "«Mandanos…» ni «Pasanos…». Lo que ya entendimos no va en esa lista: preguntá si es correcto " +
  "aparte, en una oración propia.";

// El literal de ejemplo, como con CUIDADO: sin él la guarda quema reintentos en paráfrasis.
const TRASPASO =
  "con esto se cierra la carga de datos por este medio y una persona del equipo le va a " +
  `escribir desde otro número o desde otra dirección de correo (por ejemplo: «${AVISO_DE_TRASPASO}»)`;

function buildPrompt(input: ComposeReplyInput): string {
  const items = (input.fields ?? []).map((key) => {
    const { label, instruction, kind } = labelForField(key);
    const known = input.knownValues?.[key];
    return known
      ? `- ${label}: ya entendimos: ${known}. Preguntá si es correcto con ese mismo valor adentro de la pregunta, sin comillas ni paréntesis, nunca «¿pregunta?: valor» ni «¿pregunta? valor»; no pidas más precisión ni digas que la persona lo escribió así`
      : `- ${label} — ${instruction} (${kind === "documento" ? "archivo o foto" : "dato"})`;
  });

  const conflictos = (input.conflicts ?? []).map((c) => {
    const { label } = labelForField(c.fieldKey);
    return `- ${label}: la persona dice "${c.proposed}" y nosotros tenemos "${c.stored}"`;
  });

  const intentBrief: Record<ReplyIntent, string> = {
    ask: "Pedir los datos listados. No pidas nada que no esté en la lista.",
    escalation:
      "Avisar que la denuncia se derivó a un especialista que se va a comunicar a la brevedad " +
      "(decí «un especialista», nunca «él» ni «ella»: no sabemos quién es), " +
      "y que si necesita asistencia urgente llame a la línea de emergencias de su póliza. " +
      `NO pidas ningún dato: un especialista se encarga. Avisá también que ${TRASPASO}.`,
    closing: `Avisar que ya tenemos todo lo necesario y que ${TRASPASO}. NO pidas nada.`,
    conflict: input.titularAjeno
      ? "La póliza está a nombre de otra persona que quien escribe —puede ser un familiar—, así " +
        "que los dos valores pueden ser correctos. Señalá la diferencia sin preguntar cuál es el " +
        "correcto y sin decir que la póliza o el vehículo son de quien escribe. Avisá que un " +
        "especialista va a revisar el caso y se va a comunicar (decí «un especialista», nunca " +
        "«él» ni «ella»). NO preguntes ni pidas nada: el caso ya lo tiene un especialista. " +
        `Avisá también que ${TRASPASO}.`
      : "Señalar la diferencia entre los dos valores y preguntar cuál es el correcto.",
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
${intentBrief[input.intent]}${llevaCuidado(input) ? ` Abrí (después del saludo, si saludás) con una sola frase breve de cuidado: «${CUIDADO}». No repitas ni comentes lo que contó de las heridas, la internación o la salud de nadie, no diagnostiques, no prometas nada.` : ""}
${input.question ? `\nLA PERSONA PREGUNTÓ ESTO Y HAY QUE CONTESTARLE:\n"${sinCentinelas(sinNumerosEnteros(input.question))}"\nEmpezá el mensaje contestándola, antes de cualquier lista. Contestá con lo que sabemos de verdad: en qué estado está su denuncia. Si no lo sabemos — cuánto tarda, cuánto le van a pagar, si está cubierto — decilo con honestidad y sin inventar plazos ni montos. Nunca dejes la pregunta sin responder. Sin frases hechas como «entiendo tu preocupación», y la respuesta no nombra la documentación ni lo que falta: el pedido va una sola vez, en la lista.` : ""}

${items.length > 0 && input.intent !== "acknowledgement" ? `DATOS A PEDIR:\n${items.join("\n")}\n\n${COMO_VA_LA_LISTA}` : ""}
${conflictos.length > 0 ? `\nDATOS QUE NO COINCIDEN (nombrá los dos valores de cada uno, copiados tal cual):\n${conflictos.join("\n")}` : ""}
${input.claimTypeLabel ? `\nTipo de siniestro: ${input.claimTypeLabel}` : ""}
${input.claimantName ? `\nLa persona se llama ${sinCentinelas(input.claimantName)}. Podés llamarla por su nombre de pila.` : ""}
${input.isFollowUp ? "\nYa venimos conversando con esta persona: no la saludes como si fuera el primer contacto." : "\nEs el primer mensaje que le mandamos."}
${input.lastMessage ? `\nÚLTIMO MENSAJE DE LA PERSONA (sólo para ajustar el tono, no lo respondas punto por punto ni le preguntes si es correcto algo que escribió ahí: sólo se confirma lo que dice «ya entendimos»):\n"""${sinCentinelas(sinNumerosEnteros(input.lastMessage)).slice(0, 600)}"""` : ""}

${channelBrief}

PROHIBIDO, sin excepción:
- Prometer cobertura, pagos, montos, plazos, reintegros, grúas o turnos. Nadie evaluó el siniestro todavía.
- Decir que algo está aprobado, cubierto o rechazado.
- Inventar datos, números de caso, nombres o fechas que no estén acá arriba.
- Pedir algo que no esté en la lista de datos.
- Disculpas largas, floreo, o tono de robot.

TONO: si lo que contó es grave —fuego, heridos, robo— sé sobrio y breve. Si es un
choque menor, sé cordial y directo. Nunca dramatices ni minimices. Si pidió perdón o
dijo que se equivocó, no se lo agradezcas: alcanza con un «no hay problema». Hablás
por el equipo, siempre en plural —«necesitamos», «te pedimos», «entendemos»—, nunca
«te pido» ni «entiendo».

Devolvé JSON: {"message": "<el texto del mensaje>"}`;
}

const NUCLEO: Readonly<Record<string, RegExp>> = { hay_heridos: /lastim|herid|lesion/ };

// Sólo la derivación: el orquestador marca `heridos` en la de gravedad, nunca en
// la de póliza vencida sin gravedad ni en la del titular ajeno.
function llevaCuidado(input: ComposeReplyInput): boolean {
  return input.intent === "escalation" && input.heridos === true;
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
  // Citing a value we already hold counts: "¿fue en Villa Mitre?" asks about
  // the place without saying "lugar", and the brief tells it to use that value.
  // Entero: una sola de sus palabras sale por otras razones —«Roberto» en el
  // saludo, «daños» en «Fotos de los daños»— y el campo pasaría por pedido sin
  // que la persona viera la pregunta. Y un «sí» o un «no», que es como llega un
  // booleano, están en cualquier texto: ése tiene que nombrar el campo.
  // La primera palabra con tres letras o más: «Si hubo personas lastimadas»
  // daba «si», que está en cualquier texto, y el ítem se caía sin que se note.
  // Donde esa palabra no es la que carga el sentido va la raíz: «¿Alguien
  // resultó lastimado?» pregunta lo mismo sin decir «hubo».
  if (input.intent === "ask") {
    const lower = trimmed.toLowerCase();
    for (const key of input.fields ?? []) {
      const palabras = labelForField(key).label.toLowerCase().split(/\s+/);
      const head = palabras.find((p) => p.replace(/[^\p{L}\p{N}]/gu, "").length >= 3) ?? palabras[0];
      const nombrado = NUCLEO[canonicalFieldKey(key)]?.test(lower) ?? lower.includes(head);
      const known = input.knownValues?.[key]?.trim().toLowerCase();
      const citado = !!known && known.length > 2 && lower.includes(known);
      if (!nombrado && !citado) return `dropped_field:${key}`;
    }

    // Al revés de `dropped_field`: no importa qué dice el renglón de más, con
    // que sobre uno alcanza. El choque-completo del 25/09 pidió 2 cosas —el
    // gap-analysis lo dice, `missing_fields_count:1` en el log de esa vuelta— y
    // la lista salió con 11, inventando datos de terceros que la denuncia
    // nunca mencionó. `input.fields` es la única lista real: contar renglones
    // no necesita saber qué inventó cada uno.
    if ((input.fields ?? []).length > 0) {
      const bullets = trimmed
        .split("\n")
        .filter((l) => /^[ \t]*(?:[•*\-]|\d+[.)])[ \t]+/.test(l));
      if (bullets.length > (input.fields ?? []).length) return "invented_field";
    }

    // «• ¿Hubo personas lastimadas?: no» le propone a la persona un valor que
    // quizá nunca dijo, y un «ok» lo confirma. El valor va adentro de la pregunta.
    // Después del «?» sólo cuenta un sí, un no o un valor que ya tenemos: «¿Dónde
    // fue? Calle y altura» dice qué mandar, no propone nada. En la lista o fuera:
    // la confirmación ahora va en su propia oración.
    const pegados = new Set(
      ["sí", "si", "no", ...Object.values(input.knownValues ?? {})].map((v) => v.trim().toLowerCase())
    );
    const conValor = (l: string) => {
      const cola = /\?[ \t]+([^?]+?)[ \t.!]*$/.exec(l)?.[1].toLowerCase();
      return /\?[ \t]*:|:[ \t]*(?:s[ií]|no)[ \t]*$/i.test(l) || (!!cola && pegados.has(cola));
    };
    if (trimmed.split("\n").some(conValor)) {
      return "pregunta_con_valor";
    }

    // Aun con la consigna, el ensayo del 23/09 mandó «• Hora aproximada —
    // Decinos más o menos a qué hora fue.»: copió el renglón del brief entero.
    const itemConVerbo =
      /^[ \t]*(?:[•*\-]|\d+[.)])[ \t]+(?:[^\n]*?(?:—|:)[ \t]*)?(?:decinos|mandanos|pasanos|dejanos|contanos|envianos)\b/im;
    if (itemConVerbo.test(trimmed)) return "item_con_verbo";
  }

  // Lee el último mensaje para el tono y de ahí sacó una póliza que nadie le
  // pidió confirmar (goteo, 23/09). El conflicto sí la nombra: es uno de los valores.
  if (
    input.intent !== "conflict" &&
    confirmaLoQueEscribio(
      trimmed,
      input.lastMessage && sinNumerosEnteros(input.lastMessage),
      Object.values(input.knownValues ?? {})
    )
  ) {
    return "confirma_lo_que_escribio";
  }

  // Lo mismo para el conflicto, donde más se nota: un mensaje que dice que
  // hay una diferencia sin decir entre qué valores deja a la persona sin nada
  // que contestar, y el caso trabado esperando esa respuesta. La plantilla sí
  // los decía — el redactor no puede decir menos que el piso que reemplaza.
  if (input.intent === "conflict") {
    for (const c of input.conflicts ?? []) {
      if (!trimmed.includes(c.proposed) || !trimmed.includes(c.stored)) {
        return `dropped_conflict:${c.fieldKey}`;
      }
    }
  }

  // El titular ajeno ya se derivó en esta vuelta: lo que conteste no lo lee el
  // agente, y «¿cuál es el correcto?» salió en un ensayo con los dos correctos.
  const titularAjeno = input.intent === "conflict" && input.titularAjeno === true;
  if (titularAjeno && trimmed.includes("?")) return "titular_ajeno_pregunta";
  // Escribió «el auto de mi viejo» y le contestaron «el siniestro de tu auto».
  if (titularAjeno && /\btu\s+(?:auto|veh[ií]culo|coche|camioneta|moto|p[oó]liza)\b/iu.test(trimmed)) {
    return "titular_ajeno_se_lo_atribuye";
  }
  const deriva = input.intent === "escalation" || titularAjeno;

  // An escalation that asks for something contradicts itself — that exact
  // pile-up is why escalated cases send one message and nothing else.
  if (deriva && pideDatos(trimmed)) {
    return "escalation_asks_for_data";
  }

  // Nadie sabe quién va a tomar el caso: "Él se va a comunicar" salió en un
  // ensayo, y le pone género a una persona que todavía no existe.
  if (deriva && /(?<!\p{L})(?:él|ella)\s+(?:se|te|va)\b/iu.test(trimmed)) {
    return "escalation_gendered";
  }

  if (llevaCuidado(input)) {
    // Como `dropped_conflict`: el redactor no dice menos que el piso que reemplaza.
    if (!diceCuidado(trimmed)) return "dropped_care";
    // Ni más: la frase acompaña, no repite ni pronostica lo que contó de la salud.
    if (hablaDeLaSalud(trimmed)) return "care_names_health";
  }

  // Último, para que cualquier otro rechazo conserve su motivo en el reintento.
  // Sin el aviso, la persona sigue escribiendo por acá y ya no lo lee nadie.
  if ((input.intent === "closing" || deriva) && !mencionaElTraspaso(trimmed)) {
    return "dropped_handoff";
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

  const { text, usage, model } = await callGemini(
    buildPrompt(input) + correction,
    "Escribí el mensaje y devolvelo como JSON."
  );

  // Acá y no en `composeReply`: el reintento tras una guarda rechazada es
  // una segunda llamada, facturada igual que la primera.
  await registrarConsumoDelModelo(input.tenantId, model, usage);
  if (!text) return { ok: false, problem: "no_output" };

  const parsed = JSON.parse(text) as { message?: unknown };
  // Pegada a la frase que la abre, la lista se lee en el teléfono como un bloque.
  const message =
    typeof parsed.message === "string"
      ? parsed.message.trim().replace(/:[ \t]*\n(?=[ \t]*[•*-][ \t])/g, ":\n\n")
      : "";
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
  if (problem.startsWith("dropped_conflict:")) {
    const key = problem.slice("dropped_conflict:".length);
    return `no dijiste los dos valores de "${labelForField(key).label}". Hay que nombrar el que dio la persona Y el que tenemos nosotros, copiados tal cual te los pasé.`;
  }
  if (problem.startsWith("forbidden:")) {
    return "prometiste algo sobre cobertura, pagos o plazos. Nadie evaluó el siniestro todavía.";
  }
  if (problem === "invented_field") {
    return "la lista tiene más ítems que los que te pasé. Pedí sólo lo que está en DATOS A PEDIR, ni uno más.";
  }
  if (problem === "pregunta_con_valor") {
    return "pusiste un valor pegado a una pregunta («¿…?: no»). Si tenés un valor, metelo adentro de la pregunta; si no, preguntá abierto sin proponer nada.";
  }
  if (problem === "item_con_verbo") {
    return "un ítem de la lista tiene verbo propio («Mandanos…», «Decinos…»). El verbo va una sola vez, en la frase que abre la lista; cada ítem nombra lo que falta: «Fotos de los daños».";
  }
  if (problem === "confirma_lo_que_escribio") {
    return "le preguntaste si es correcto algo que la persona acaba de escribir. Eso ya lo tenemos: no se lo devuelvas. Confirmá sólo lo que dice «ya entendimos».";
  }
  if (problem === "too_long") return "es demasiado largo. Cortálo.";
  if (problem === "too_short") return "es demasiado corto.";
  if (problem === "escalation_asks_for_data") {
    return "pediste datos en un mensaje de derivación. No hay que pedir nada: se encarga un especialista.";
  }
  if (problem === "dropped_care") {
    return `no abriste con la frase de cuidado. Después del saludo, si saludás, decí «${CUIDADO}», y no hables de las heridas ni de la salud de nadie.`;
  }
  if (problem === "care_names_health") {
    return `nombraste las heridas, la internación o la salud de alguien. Alcanza con «${CUIDADO}»: no repitas lo que contó ni digas cómo va a estar nadie.`;
  }
  if (problem === "dropped_handoff") {
    return `te faltó avisar que la carga se cierra acá y que una persona le va a escribir desde otro número o correo. Podés decirlo así: «${AVISO_DE_TRASPASO}».`;
  }
  if (problem === "escalation_gendered") {
    return "le pusiste género al especialista. No sabemos quién es: decí «un especialista».";
  }
  if (problem === "titular_ajeno_pregunta") {
    return "hiciste una pregunta. La póliza es de otra persona y el caso ya lo tiene un especialista: nombrá la diferencia y avisá eso, sin preguntar nada.";
  }
  if (problem === "titular_ajeno_se_lo_atribuye") {
    return "dijiste que el vehículo o la póliza son de quien escribe, y son del titular. Decí «el auto» o «la póliza».";
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

    logger.warn({
        intent: input.intent,
        channel: input.channel,
        reason: second.problem,
        first_reason: first.problem,
      }, "compose.rejected");
    return withUnansweredQuestion(input);
  } catch (err) {
    const meta = errMeta(err);
    logger.error({
        intent: input.intent,
        channel: input.channel,
        error_name: meta.name,
        status: meta.status,
        code: meta.code,
        detalle: err instanceof Error ? err.message.slice(0, 200) : undefined,
      }, "compose.failed");
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
  return conRespuestaPendiente(input.fallback, input.question);
}
