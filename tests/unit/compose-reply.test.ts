/**
 * Letting the model write, without letting it decide.
 *
 * The orchestrator picks what to say; this only picks how. Everything here is
 * about the second half not quietly changing the first — a message that drops
 * one of the four fields we asked for, an escalation that asks for data after
 * promising nobody has to do anything, or a sentence that commits the insurer
 * to paying before anyone looked at the claim.
 *
 * When a check fails the claimant gets the template. Duller, always correct.
 */

vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: vi.fn(),
  errMeta: (e: unknown) => ({
    name: e instanceof Error ? e.name : "UnknownError",
    status: null,
    code: null,
  }),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { composeReply } from "@/server/ai/compose-reply";
import { callGemini } from "@/server/ai/gemini-extractor";
import { RESPUESTA_PENDIENTE } from "@/core/mensajes/respuesta-pendiente";

const mockCall = callGemini as unknown as ReturnType<typeof vi.fn>;

const FALLBACK = "Texto de plantilla, siempre correcto.";

function base(over: Partial<Parameters<typeof composeReply>[0]> = {}) {
  return {
    intent: "ask" as const,
    channel: "whatsapp" as const,
    // De quien es el gasto. Requerido desde que composeReply registra su
    // consumo: las llamadas del redactor no aparecian en `ai_usage`.
    tenantId: "10000000-0000-0000-0000-000000000001",
    fallback: FALLBACK,
    ...over,
  };
}

/** Make the model return this message. */
function replies(message: string) {
  mockCall.mockResolvedValue({
    text: JSON.stringify({ message }),
    usage: { promptTokens: 0, completionTokens: 0 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENT_COMPOSE_REPLIES;
});

describe("composeReply — when it works", () => {
  it("uses the written message over the template", async () => {
    replies(
      "Lamento lo del choque. Para seguir necesito el número de póliza y tu DNI, " +
        "cuando puedas me los pasás por acá."
    );

    const out = await composeReply(
      base({ fields: ["policy_number", "dni"], lastMessage: "Choqué en Alem" })
    );

    expect(out).toContain("póliza");
    expect(out).not.toBe(FALLBACK);
  });
});

describe("composeReply — what it refuses to send", () => {
  it("refuses a message that quietly drops a field we asked for", async () => {
    // The orchestrator asked for four things; the claimant would see three,
    // answer them, and be asked again for the fourth.
    replies("Necesito tu número de póliza y el DNI del titular para seguir.");

    const out = await composeReply(
      base({ fields: ["policy_number", "dni", "accident_date"] })
    );

    expect(out).toBe(FALLBACK);
  });

  it("takes a quoted known value as asking for it", async () => {
    // The brief says to cite the value; "¿fue en Villa Mitre?" never says "lugar".
    replies("¿Es correcto que el choque fue en Villa Mitre? Si no, contanos dónde fue.");

    const out = await composeReply(
      base({ fields: ["accident_location"], knownValues: { accident_location: "Villa Mitre" } })
    );

    expect(out).not.toBe(FALLBACK);
  });

  // El valor llega dicho como una persona, y así lo repite el redactor.
  it.each([
    ["accident_date", "22 de septiembre", "¿El choque fue el 22 de septiembre? Si no, contanos qué día fue."],
    ["hora_siniestro", "tarde", "¿Fue a la tarde, más o menos?"],
    ["claim_type", "daño por granizo", "¿Fue un daño por granizo? Si no, contanos qué pasó."],
    ["accident_date", "15 de marzo de 2024", "¿Fue el 15 de marzo de 2024? Si no, contanos qué día."],
    // Un booleano llega como «no»: la pregunta lo cita nombrando el campo.
    ["testigos", "no", "¿Es correcto que no hubo testigos? Si hubo, pasanos sus datos."],
  ])("toma %s dicho con su valor legible como pedido", async (campo, valor, mensaje) => {
    replies(mensaje);

    const out = await composeReply(base({ fields: [campo], knownValues: { [campo]: valor } }));

    expect(out).not.toBe(FALLBACK);
  });

  it("no toma como citado un valor del que sólo quedan palabras chicas", async () => {
    replies("Para seguir necesitamos que nos pases el número de póliza, por favor.");

    const out = await composeReply(
      base({ fields: ["claim_type"], knownValues: { claim_type: "choque de vehículo" } })
    );

    expect(out).toBe(FALLBACK);
  });

  // Se saltea la confirmación, pero una palabra del valor sale por otro lado: el
  // nombre de pila en el saludo, la etiqueta de otro campo, la empatía, o un
  // «no» cualquiera. Pasarlo es dar por preguntado lo que la persona no vio.
  // Los otros campos del pedido sí están nombrados, así que lo único que falta
  // es la confirmación; con ella, el mismo mensaje pasa.
  const sinConfirmar = [
    [
      "full_name",
      "Roberto Paz",
      ["dni"],
      "¡Gracias, Roberto! Para seguir necesitamos el DNI del titular.",
      "¿Sos Roberto Paz?",
    ],
    [
      "claim_type",
      "daño por granizo",
      ["fotos_danos", "dni"],
      "Para seguir, mandanos las fotos de los daños y el DNI del titular.",
      "¿Fue un daño por granizo?",
    ],
    [
      "claim_type",
      "choque de vehículo",
      ["dni", "patente_vehiculo"],
      "Lamentamos lo del choque. Pasanos el DNI del titular y la patente del vehículo.",
      "¿Fue un choque de vehículo?",
    ],
    [
      "accident_date",
      "22 de septiembre",
      ["dni"],
      "Recibimos tu denuncia de septiembre. Pasanos el DNI del titular, por favor.",
      "¿Fue el 22 de septiembre?",
    ],
    [
      "testigos",
      "no",
      ["dni"],
      "Para seguir necesitamos el DNI del titular, así no se demora tu denuncia.",
      "¿Es correcto que no hubo testigos?",
    ],
  ] as const;

  it.each(
    sinConfirmar.flatMap((c) => (["whatsapp", "email"] as const).map((canal) => [...c, canal] as const))
  )("no da por citado %s «%s» por una palabra suelta (%#)", async (campo, valor, otros, mensaje, _, canal) => {
    replies(mensaje);

    const out = await composeReply(
      base({
        channel: canal,
        claimantName: "Roberto Paz",
        fields: [campo, ...otros],
        knownValues: { [campo]: valor },
      })
    );

    expect(out).toBe(FALLBACK);
  });

  it.each(sinConfirmar)(
    "toma %s «%s» cuando la pregunta sí está",
    async (campo, valor, otros, mensaje, pregunta) => {
      replies(`${mensaje} ${pregunta}`);

      const out = await composeReply(
        base({
          claimantName: "Roberto Paz",
          fields: [campo, ...otros],
          knownValues: { [campo]: valor },
        })
      );

      expect(out).not.toBe(FALLBACK);
    }
  );

  it("refuses an escalation that turns around and asks for data", async () => {
    // The exact contradiction that reached a real chat: "no hace falta que
    // hagas nada" followed by a list of requests.
    replies(
      "Derivamos tu denuncia a un especialista. Mientras tanto necesitamos que nos envíes el DNI."
    );

    const out = await composeReply(base({ intent: "escalation" }));

    expect(out).toBe(FALLBACK);
  });

  it("refuses an escalation that gives the specialist a gender", async () => {
    replies("Ya derivamos tu denuncia a un especialista. Él se va a comunicar con vos a la brevedad.");

    const out = await composeReply(base({ intent: "escalation" }));

    expect(out).toBe(FALLBACK);
    expect(mockCall.mock.calls[1][0] as string).toContain("le pusiste género al especialista");
  });

  it("does not mistake an ordinary word for a pronoun", async () => {
    replies("Ya derivamos tu denuncia a un especialista, que se va a comunicar con vos a la brevedad.");

    const out = await composeReply(base({ intent: "escalation" }));

    expect(out).not.toBe(FALLBACK);
  });

  it("refuses to promise anything about the money", async () => {
    for (const promise of [
      "El siniestro está cubierto, te vamos a pagar el arreglo.",
      "Tu reclamo fue aprobado y te depositamos 350000 pesos.",
      "Resolvemos esto en 48 horas.",
      "Te mandamos una grúa ahora mismo.",
    ]) {
      replies(promise + " Necesito tu número de póliza.");
      const out = await composeReply(base({ fields: ["policy_number"] }));
      expect(out, promise).toBe(FALLBACK);
    }
  });

  it("refuses a message too long to read on a phone", async () => {
    replies("Necesito tu número de póliza. " + "Detalle innecesario. ".repeat(60));

    const out = await composeReply(base({ fields: ["policy_number"] }));

    expect(out).toBe(FALLBACK);
  });

  it("allows the same length in an email", async () => {
    const long = "Necesito tu número de póliza. " + "Explicación útil. ".repeat(20);
    replies(long);

    const out = await composeReply(
      base({ channel: "email", fields: ["policy_number"] })
    );

    expect(out).toBe(long.trim());
  });
});

describe("composeReply — when it cannot", () => {
  it("falls back when the model returns nothing", async () => {
    mockCall.mockResolvedValue({ text: null, usage: {} });
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("falls back on unparseable output", async () => {
    mockCall.mockResolvedValue({ text: "no soy json", usage: {} });
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("falls back on an empty message field", async () => {
    replies("   ");
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("falls back when the call throws — a claim must still get an answer", async () => {
    mockCall.mockRejectedValue(new Error("no API key"));
    expect(await composeReply(base())).toBe(FALLBACK);
  });

  it("can be turned off entirely without touching code", async () => {
    // A switch matters here: if composition starts misbehaving in production,
    // the templates are one env var away and nobody has to deploy.
    process.env.AGENT_COMPOSE_REPLIES = "off";
    replies("Un mensaje perfectamente bueno sobre tu número de póliza.");

    expect(await composeReply(base({ fields: ["policy_number"] }))).toBe(FALLBACK);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe("composeReply — the brief it hands the model", () => {
  it("tells it exactly which fields to ask for, and their instructions", async () => {
    replies("Necesito el número de póliza y las fotos de los daños.");

    await composeReply(base({ fields: ["policy_number", "fotos_danos"] }));

    const prompt = mockCall.mock.calls[0][0] as string;
    expect(prompt).toContain("Número de póliza");
    expect(prompt).toContain("Fotos de los daños");
    // Documents and facts are distinguished, so it does not ask for a phone
    // number "como foto".
    expect(prompt).toContain("archivo o foto");
  });

  it("passes a value we already hold as something to correct, not request", async () => {
    replies("Confirmame la fecha del siniestro, entendimos el 16 de agosto.");

    await composeReply(
      base({ fields: ["accident_date"], knownValues: { accident_date: "16/08/2026" } })
    );

    const prompt = mockCall.mock.calls[0][0] as string;
    expect(prompt).toContain("16/08/2026");
    expect(prompt).toContain("Preguntá si es correcto");
    expect(prompt).toContain("no pidas más precisión");
    // Con comillas y «tal cual» el modelo escribió «hora aproximada fue "tarde"».
    expect(prompt).not.toContain('"16/08/2026"');
    expect(prompt).not.toContain("tal cual");
  });

  it("puts the answer to a question before what is still missing", async () => {
    replies("No te puedo dar un plazo todavía. Mientras, necesito el número de póliza.");

    await composeReply(base({ fields: ["policy_number"], question: "¿Cuánto tarda?" }));

    expect(mockCall.mock.calls[0][0] as string).toContain("Empezá el mensaje contestándola");
  });

  it("la pregunta llega al prompt sin el DNI entero", async () => {
    // Sin plan, la pregunta sale del mensaje crudo y no del resumen del agente.
    replies("Todavía no te puedo decir. Mientras, necesito el número de póliza.");

    await composeReply(
      base({ fields: ["policy_number"], question: "¿Les mando el DNI 28.400.900?" })
    );

    const prompt = mockCall.mock.calls[0][0] as string;
    expect(prompt).toContain("****0900");
    expect(prompt).not.toContain("28.400.900");
    expect(prompt).not.toContain("28400900");
  });

  it("says whether this is a first contact or a conversation already underway", async () => {
    replies("Ya tenemos todo lo necesario, tu denuncia pasa a análisis.");
    await composeReply(base({ intent: "closing", isFollowUp: true }));
    expect(mockCall.mock.calls[0][0] as string).toContain("Ya venimos conversando");

    vi.clearAllMocks();
    replies("Recibimos tu denuncia, ya quedó registrada.");
    await composeReply(base({ intent: "closing" }));
    expect(mockCall.mock.calls[0][0] as string).toContain("primer mensaje");
  });
});

/**
 * El canal de correo, que hasta hoy nadie ejercitaba.
 *
 * Todos los casos de arriba usan WhatsApp salvo el único de largo: el tope de
 * 1400, el ×1.4 con pregunta y el brief de mail estaban escritos y sin probar
 * porque el correo no pasaba por acá.
 */
describe("composeReply — por correo", () => {
  it("le pide un cuerpo de email, no un mensaje de chat", async () => {
    replies("Necesito el número de póliza para poder seguir con tu reclamo.");

    await composeReply(base({ channel: "email", fields: ["policy_number"] }));

    const prompt = mockCall.mock.calls[0][0] as string;
    expect(prompt).toContain("Es el cuerpo de un email");
    expect(prompt).not.toContain("mensaje de WhatsApp");
  });

  it("contestar una pregunta necesita más lugar que pedir a secas", async () => {
    // 1400 con el tope de mail; 1960 cuando además hay que contestar algo.
    const largo = "Necesito tu número de póliza. " + "Explicación útil. ".repeat(85);
    expect(largo.length).toBeGreaterThan(1400);
    expect(largo.length).toBeLessThan(1960);
    replies(largo);

    const sinPregunta = await composeReply(base({ channel: "email", fields: ["policy_number"] }));
    expect(sinPregunta).toBe(FALLBACK);

    vi.clearAllMocks();
    replies(largo);
    const conPregunta = await composeReply(
      base({ channel: "email", fields: ["policy_number"], question: "¿cuánto tarda?" })
    );
    expect(conPregunta).toBe(largo.trim());
  });
});

describe("la respuesta pendiente vive una sola vez", () => {
  it("no se pega otra vez si el piso ya la trae", async () => {
    /*
     * La plantilla de datos faltantes ya agrega la frase cuando hay pregunta, y
     * este camino la volvía a pegar: la misma oración dos veces seguidas,
     * salida del archivo cuya razón de existir es que viva una sola vez. Y
     * rompía además la comparación del mensajero contra el piso, que es cómo se
     * sabe que un rechazo devuelve la plantilla intacta.
     */
    const piso = `${FALLBACK}\n\n${RESPUESTA_PENDIENTE}`;
    mockCall.mockRejectedValue(new Error("sin modelo"));

    const out = await composeReply(
      base({ fallback: piso, question: "¿cuánto tarda esto?" })
    );

    expect(out).toBe(piso);
    expect(out.split(RESPUESTA_PENDIENTE).length - 1).toBe(1);
  });

  it("pero se sigue agregando cuando el piso no la tiene", async () => {
    mockCall.mockRejectedValue(new Error("sin modelo"));

    const out = await composeReply(base({ question: "¿cuánto tarda esto?" }));

    expect(out).toContain(RESPUESTA_PENDIENTE);
  });
});

describe("composeReply — quien escribe no es el titular", () => {
  /*
   * Escribe la hija por el auto del padre. Los dos nombres son correctos, así
   * que «¿cuál es el correcto?» no tiene respuesta, y el caso ya lo tiene un
   * especialista: nadie del lado del agente lee lo que conteste.
   */
  const ajeno = (over: Partial<Parameters<typeof composeReply>[0]> = {}) =>
    base({
      intent: "conflict",
      titularAjeno: true,
      conflicts: [
        { fieldKey: "full_name", proposed: "Lucía Paz", stored: "R*** P***" },
        { fieldKey: "dni", proposed: "****0140", stored: "****7663" },
      ],
      ...over,
    });

  const DICE_LA_DIFERENCIA =
    "Recibimos tu denuncia. La póliza figura a nombre de R*** P*** (DNI ****7663) " +
    "y vos nos decís Lucía Paz (DNI ****0140).";

  it("rechaza que pregunte cuál es el correcto", async () => {
    replies(`${DICE_LA_DIFERENCIA} ¿Cuál es el correcto?`);

    expect(await composeReply(ajeno())).toBe(FALLBACK);
    expect(mockCall.mock.calls[1][0] as string).toContain("hiciste una pregunta");
  });

  it("toma el que nombra la diferencia y avisa que la revisa un especialista", async () => {
    replies(`${DICE_LA_DIFERENCIA} Un especialista va a revisar tu caso y se va a comunicar con vos.`);

    expect(await composeReply(ajeno())).not.toBe(FALLBACK);
    expect(mockCall.mock.calls[0][0] as string).toContain("sin preguntar cuál es el correcto");
  });

  it("rechaza que le atribuya el auto a quien escribe", async () => {
    // Lucía escribió «el auto de mi viejo» y le contestaron «tu auto».
    replies(`${DICE_LA_DIFERENCIA} Un especialista va a revisar el siniestro de tu auto.`);

    expect(await composeReply(ajeno())).toBe(FALLBACK);
    expect(mockCall.mock.calls[1][0] as string).toContain("son del titular");
  });

  it("tampoco le pone género al especialista", async () => {
    replies(`${DICE_LA_DIFERENCIA} Un especialista va a revisar tu caso. Él se va a comunicar con vos.`);

    expect(await composeReply(ajeno())).toBe(FALLBACK);
  });

  it("el conflicto de siempre sigue preguntando", async () => {
    replies(`${DICE_LA_DIFERENCIA} ¿Cuál es el correcto?`);

    expect(await composeReply(ajeno({ titularAjeno: false }))).not.toBe(FALLBACK);
  });
});
