/**
 * Saying the orchestrator's decision out loud on WhatsApp.
 *
 * WhatsApp used to reach its own conclusions in server/whatsapp/notify.ts,
 * which is how the two channels drifted: a reported fire was answered with a
 * routine receipt, and a follow-up message with nothing at all. The decision
 * now comes from the same place the email one does; only the wording and the
 * transport are this module's problem.
 *
 * The failure modes here are not crashes. They are a message that reads like
 * the database spoke, a list so long nobody answers it, and a real WhatsApp
 * message sent to a number a simulation invented.
 */

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: hay tests que
// intercambian la base simulada entre casos, y un `const { db } = ...`
// congelaría el valor de la primera.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: { insert: vi.fn() },
}));

vi.mock("@/server/whatsapp/cloud-api", () => ({
  sendWhatsAppText: vi.fn(),
}));

vi.mock("@/server/email/dispatch", () => ({
  dispatchOutboundEmail: vi.fn().mockResolvedValue(undefined),
}));

// Sin modelo: lo que se prueba acá es el piso, y un test no llama a Gemini.
vi.mock("@/server/ai/gemini-extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ai/gemini-extractor")>()),
  callGemini: vi.fn().mockRejectedValue(new Error("sin modelo en tests")),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  whatsappMessenger,
  simulatedWhatsappMessenger,
  messengerFor,
  emailMessenger,
} from "@/server/confirmations/messenger";
import { db } from "@/lib/db";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";
import { callGemini, GeminiExtractionError } from "@/server/ai/gemini-extractor";
import { RESPUESTA_PENDIENTE } from "@/core/mensajes/respuesta-pendiente";
import { CUIDADO, diceCuidado, hablaDeLaSalud } from "@/core/mensajes/derivacion";
import {
  AVISO_DE_TRASPASO,
  NO_HACE_FALTA_CONTESTAR,
  SI_VOLVES_A_ESCRIBIR,
  mencionaElTraspaso,
} from "@/core/mensajes/traspaso";
import { pideAlgo } from "../../scripts/lib/pide-algo.mjs";
import type { EmailTemplate } from "@/server/email/render";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";
const TO = "5491100000000";

let inserted: Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  inserted = [];
  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return Promise.resolve();
    },
  });
  (sendWhatsAppText as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
});

function sentBody(): string {
  return (sendWhatsAppText as ReturnType<typeof vi.fn>).mock.calls[0][1];
}

/** Reset between two sends inside one test. */
function resetSend() {
  vi.clearAllMocks();
  (sendWhatsAppText as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
}

async function send(template: EmailTemplate, data: Record<string, unknown>) {
  await whatsappMessenger.send({ caseId: CASE, tenantId: TENANT, to: TO, template, data });
}

describe("whatsappMessenger — what it says", () => {
  it("sends someone reporting a serious claim to a person, not a document list", async () => {
    await send("specialist_escalation", { caseId: CASE, severity: "critical" });

    const body = sentBody();
    expect(body).toContain("especialista");
    expect(body).not.toContain("•");
  });
  /*
   * El mismo caso, por correo, nombra los dos valores que no coinciden. Por
   * acá salía sin ellos: quien escribe por la póliza de su padre recibía «pasó
   * a un especialista» y nada con qué contestar. AC7/AC9 cumplido en un canal y
   * no en el otro es peor que incumplido en los dos, porque nadie lo mira.
   */
  it("dice los dos valores cuando el titular del padrón no es quien escribe", async () => {
    await send("specialist_escalation", {
      caseId: CASE,
      titularIniciales: "R*** P***",
      claimantName: "Lucía Paz",
    });

    const body = sentBody();
    expect(body).toContain("R*** P***");
    expect(body).toContain("Lucía Paz");
    expect(body).toContain("especialista");
  });

  it("y el nombre del padrón nunca entero", async () => {
    // El tipo sólo acepta iniciales, pero si alguien le pasa el nombre entero
    // por este camino tiene que notarse acá y no en la casilla de una persona.
    await send("specialist_escalation", {
      caseId: CASE,
      titularIniciales: "R*** P***",
      claimantName: "Lucía Paz",
    });

    expect(sentBody()).not.toContain("Roberto Paz");
  });

  it("la diferencia va detrás del aviso y no invita a contestar", async () => {
    await send("specialist_escalation", {
      caseId: CASE,
      titularIniciales: "R*** P***",
      claimantName: "Lucía Paz",
    });

    const body = sentBody();
    const tras = body.slice(body.indexOf(AVISO_DE_TRASPASO) + AVISO_DE_TRASPASO.length);
    expect(tras).toContain("R*** P***");
    expect(tras).not.toMatch(/contanos/i);
    expect(pideAlgo(tras.toLowerCase())).toBe(false);
  });

  it("un escalado por severidad no menciona ningún padrón", async () => {
    await send("specialist_escalation", { caseId: CASE, severity: "critical" });

    expect(sentBody()).not.toContain("figura a nombre de");
  });

  it("names every field in Spanish, never the database key", async () => {
    // A real reply once listed dni_asegurado and telefono_contacto verbatim.
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["dni_asegurado", "telefono_contacto", "hora_siniestro"],
    });

    const body = sentBody();
    expect(body).toContain("• DNI del asegurado");
    expect(body).toContain("• Teléfono de contacto");
    expect(body).toContain("• Hora aproximada");
    expect(body).not.toContain("_");
  });

  it("offers a correction for a value we already hold", async () => {
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["policy_number", "accident_date"],
      knownValues: { accident_date: "16/08/2026" },
    });

    const body = sentBody();
    expect(body).toContain("Fecha del siniestro: entendimos");
    expect(body).toContain("16/08/2026");
    expect(body).toContain("Si algo de lo que entendimos no es correcto");
    // The one we do not hold is still asked for plainly.
    expect(body).toContain("• Número de póliza");
  });

  // El valor llega legible desde el orquestador. Traducirlo otra vez lo
  // borraba: «daño por granizo» no es un tipo.
  it("no traduce dos veces lo que ya llega legible", async () => {
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["claim_type"],
      knownValues: { claim_type: "daño por granizo" },
    });

    expect(sentBody()).toContain('Tipo de siniestro: entendimos "daño por granizo"');
  });

  it("asks for at most five things, and says the rest is coming", async () => {
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: Array.from({ length: 9 }, (_, i) => `dato_${i}`),
    });

    const body = sentBody();
    expect((body.match(/•/g) ?? []).length).toBe(5);
    expect(body).toContain("Para empezar");
    expect(body).toContain("Después te pedimos el resto");
  });

  it("does not promise a follow-up when everything fits", async () => {
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["dni", "policy_number"],
    });

    expect(sentBody()).not.toContain("Después te pedimos el resto");
  });

  it("only mentions photos when it actually asked for one", async () => {
    // Telling someone to send their phone number as a photo is the same kind
    // of tell as printing the raw key.
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["telefono_contacto"],
    });
    expect(sentBody()).not.toContain("foto");

    resetSend();
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["fotos_danos"],
    });
    const withDocs = sentBody();
    expect(withDocs).toContain("que nos mandes:");
    expect(withDocs).toContain("las fotos o archivos mandalos por este chat");
  });

  it("keeps facts and documents apart when it asks for both", async () => {
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["telefono_contacto", "fotos_danos"],
    });

    const body = sentBody();
    expect(body).toContain("que nos cuentes:");
    expect(body).toContain("Y que nos mandes:");
    expect(body.indexOf("que nos cuentes:")).toBeLessThan(body.indexOf("Y que nos mandes:"));
  });

  it("acknowledges on first contact and closes once the exchange happened", async () => {
    await send("confirmation_received", { caseId: CASE, claimType: "choque" });
    expect(sentBody()).toContain("Recibimos tu denuncia de choque de vehículo");

    resetSend();
    await send("confirmation_received", {
      caseId: CASE,
      claimType: "choque",
      isFollowUp: true,
    });
    const body = sentBody();
    expect(body).toContain("ya tenemos todo lo que necesitábamos");
    expect(body).not.toContain("Recibimos tu denuncia de");
  });

  it.each([false, true])("el cierre avisa el traspaso (isFollowUp: %s)", async (isFollowUp) => {
    await send("confirmation_received", { caseId: CASE, claimType: "choque", isFollowUp });

    const body = sentBody();
    expect(body).toContain(AVISO_DE_TRASPASO);
    expect(mencionaElTraspaso(body)).toBe(true);
    expect(body).not.toContain("Un analista");
  });

  it("shows both values when ours disagrees with theirs", async () => {
    await send("data_confirmation_request", {
      caseId: CASE,
      fieldKey: "full_name",
      proposedValue: "Pedro García",
      conflictWithValue: "Juan Pérez",
    });

    const body = sentBody();
    expect(body).toContain("Pedro García");
    // El nombre guardado es el de nuestro padrón, no lo que escribió el
    // remitente: repetirlo entero le confirma a cualquiera con un DNI el
    // nombre del titular sin haber probado nada.
    expect(body).not.toContain("Juan Pérez");
    expect(body).toContain("J*** P***");
  });

  /*
   * Tres datos que no coinciden son un mensaje, no tres.
   *
   * Por WhatsApp era peor que por mail: tres notificaciones seguidas en el
   * teléfono de la persona, cada una diciendo casi lo mismo.
   */

  /*
   * ── El DNI no sale entero por WhatsApp ──────────────────────────────────
   *
   * `renderConflict` es el PISO de la respuesta: el texto que sale byte por
   * byte cuando el redactor está apagado, cuando las guardas lo rechazan o
   * cuando tira excepción. Interpolaba `c.proposed` y `c.stored` en crudo, así
   * que el documento completo del asegurado quedaba visible en la notificación
   * de la pantalla bloqueada.
   *
   * El enmascarado existía, pero vivía adentro de la función que arma el prompt
   * del modelo: se aplicaba a lo que LEE el modelo y no a lo que LEE la persona.
   */
  it("enmascara el DNI y la póliza en el mensaje de conflicto", async () => {
    await send("data_confirmation_request", {
      caseId: CASE,
      fields: [
        { fieldKey: "dni", proposedValue: "30123456", conflictWithValue: "30987654" },
        {
          fieldKey: "policy_number",
          proposedValue: "POL-12345678",
          conflictWithValue: "POL-87654321",
        },
      ],
    });

    const body = sentBody();

    // Ninguno de los cuatro valores sale entero.
    expect(body).not.toContain("30123456");
    expect(body).not.toContain("30987654");
    expect(body).not.toContain("12345678");
    expect(body).not.toContain("87654321");

    // Pero sí los últimos cuatro dígitos, que son con los que la persona
    // reconoce cuál es cuál.
    expect(body).toContain("****3456");
    expect(body).toContain("****7654");
  });

  it("lo que escribió la persona sale entero; lo que tenemos guardado, no", async () => {
    // El control que impide que el arreglo sea «enmascarar todo»: sin el
    // valor propuesto a la vista, el mensaje no dice qué hay que corregir.
    await send("data_confirmation_request", {
      caseId: CASE,
      fieldKey: "full_name",
      proposedValue: "Pedro García",
      conflictWithValue: "Juan Pérez",
    });

    const body = sentBody();
    expect(body).toContain("Pedro García");
    expect(body).not.toContain("Juan Pérez");
    expect(body).toContain("J*** P***");
  });

  it("lista los tres datos en un solo mensaje", async () => {
    await send("data_confirmation_request", {
      caseId: CASE,
      fields: [
        { fieldKey: "full_name", proposedValue: "Pedro García", conflictWithValue: "Juan Pérez" },
        { fieldKey: "email", proposedValue: "pedro@ejemplo.com", conflictWithValue: "juan@ejemplo.com" },
      ],
    });

    const body = sentBody();
    expect(body).toContain("Pedro García");
    expect(body).not.toContain("Juan Pérez");
    expect(body).toContain("J*** P***");
    expect(body).toContain("pedro@ejemplo.com");
    expect(body).not.toContain("juan@ejemplo.com");
    expect(body).toContain("j***@ejemplo.com");
    // En plural, porque son varios.
    expect(body).toMatch(/datos que no coinciden/i);
    expect(body).toMatch(/cuáles son los correctos/i);
  });

  it("con uno solo sigue hablando en singular", async () => {
    await send("data_confirmation_request", {
      caseId: CASE,
      fields: [
        { fieldKey: "full_name", proposedValue: "Pedro García", conflictWithValue: "Juan Pérez" },
      ],
    });

    const body = sentBody();
    expect(body).toMatch(/un dato que no coincide/i);
    expect(body).toMatch(/cuál es el correcto/i);
  });

  it("si quien escribe no es el titular, nombra la diferencia y no pregunta", async () => {
    // Los dos valores son correctos —la hija escribe por el auto del padre— y
    // el caso ya se derivó en esta vuelta: no hay a quién contestarle.
    await send("data_confirmation_request", {
      caseId: CASE,
      titularAjeno: true,
      fields: [
        { fieldKey: "full_name", proposedValue: "Lucía Paz", conflictWithValue: "Roberto Paz" },
        { fieldKey: "dni", proposedValue: "30120140", conflictWithValue: "14937663" },
      ],
    });

    const body = sentBody();
    expect(body).toContain("no coinciden con los del titular");
    expect(body).toContain("un especialista va a revisar tu caso");
    expect(body).not.toContain("?");
    expect(body).not.toMatch(/respondé/i);
    expect(body).toContain("Lucía Paz");
    expect(body).toContain("R*** P***");
    expect(body).not.toContain("Roberto Paz");
    expect(body).toContain("****0140");
    expect(body).not.toContain("14937663");
    expect(body).toContain(AVISO_DE_TRASPASO);
    expect(mencionaElTraspaso(body)).toBe(true);
  });

  it("sin valores que mostrar, pide los datos por su nombre", async () => {
    await send("data_confirmation_request", {
      caseId: CASE,
      fields: [
        { fieldKey: "full_name", proposedValue: "" },
        { fieldKey: "policy_number", proposedValue: "" },
      ],
    });

    const body = sentBody();
    // No puede quedar un mensaje que muestre comillas vacías.
    expect(body).not.toContain('""');
    expect(body).toMatch(/confirmes estos datos/i);
  });

  it("derivado sin valores que mostrar, avisa el traspaso y no pide nada", async () => {
    await send("data_confirmation_request", {
      caseId: CASE,
      titularAjeno: true,
      fields: [{ fieldKey: "full_name", proposedValue: "" }],
    });

    const body = sentBody();
    expect(body).toContain(AVISO_DE_TRASPASO);
    expect(body).not.toMatch(/respondé/i);
    expect(pideAlgo(body.toLowerCase())).toBe(false);
  });
});

/**
 * El acuse de recibo, que existe para no dejar a nadie hablando solo.
 *
 * La regla de no repetir el pedido es correcta y deja un hueco: alguien que
 * cuenta algo mientras falta lo mismo de antes no recibía nada. El acuse llena
 * ese hueco, y su única obligación es no convertirse en el pedido otra vez.
 *
 * No es hipotético: la primera versión le pasaba la lista al redactor «para que
 * sepa qué NO pedir» y salió «Ana, tomamos nota de lo que nos contaste. Para
 * seguir, necesitamos que nos digas el número de póliza». Una lista de campos
 * en un prompt es una lista de cosas para pedir, diga lo que diga la
 * instrucción de al lado.
 */
describe("whatsappMessenger — a un número inventado no le escribe nadie", () => {
  it("no llama a Meta cuando el destino es del bloque reservado", async () => {
    // La restricción vivía sólo en el mensajero simulado, y eso alcanzaba
    // mientras inventar un asegurado fuera cosa del camino simulado. Una
    // prueba que entra por el webhook firmado usa el mensajero real, y ahí el
    // intento de envío sale hacia Meta — que es por lo que restringen una
    // cuenta de WhatsApp Business.
    await whatsappMessenger.send({
      caseId: CASE,
      tenantId: TENANT,
      to: "5490000123456",
      template: "missing_information_request",
      data: { caseId: CASE, missingFields: ["policy_number"] },
    });

    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("igual deja anotado lo que habría dicho", async () => {
    await whatsappMessenger.send({
      caseId: CASE,
      tenantId: TENANT,
      to: "+54 9 0000 12 3456",
      template: "missing_information_request",
      data: { caseId: CASE, missingFields: ["policy_number"] },
    });

    // Con espacios y con el +: es el mismo destinatario escrito distinto.
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(inserted[0]?.status).toBe("skipped_simulated");
  });

  it("a un número de verdad sí le manda", async () => {
    await whatsappMessenger.send({
      caseId: CASE,
      tenantId: TENANT,
      to: TO,
      template: "missing_information_request",
      data: { caseId: CASE, missingFields: ["policy_number"] },
    });

    expect(sendWhatsAppText).toHaveBeenCalled();
  });
});

describe("whatsappMessenger — tomar nota sin repetir el pedido", () => {
  it("dice que tomó nota", async () => {
    await send("information_received", { caseId: CASE });
    expect(sentBody().toLowerCase()).toContain("nota");
  });

  it("no enumera nada, ni aunque le manden la lista", async () => {
    // La defensa es doble a propósito: el orquestador ya no manda los campos,
    // y si alguien los vuelve a mandar, esto tiene que seguir sin listarlos.
    await send("information_received", {
      caseId: CASE,
      missingFields: ["policy_number", "dni_asegurado", "hora_siniestro"],
    });

    const body = sentBody();
    expect(body).not.toContain("•");
    expect(body).not.toContain("póliza");
    expect(body).not.toContain("DNI");
  });

  it("no dice que esté todo listo, porque no lo está", async () => {
    await send("information_received", { caseId: CASE });

    const body = sentBody().toLowerCase();
    expect(body).not.toContain("todo lo necesario");
    expect(body).not.toContain("quedó completo");
  });

  it("queda en el libro con su propio nombre", async () => {
    // Un acuse no es un pedido ni un cierre: si se anotara como cualquiera de
    // los dos, alreadyAskedFor leería mal lo último que dijimos.
    await send("information_received", { caseId: CASE });
    expect(inserted[0]?.template).toBe("wa_information_received");
  });
});

/*
 * Una pregunta se contesta aunque el redactor no escriba nada.
 *
 * Con el interruptor apagado `composeReply` devuelve el piso crudo, y el piso
 * de WhatsApp no traía la frase: la pregunta del ensayo `pregunta` del 22/09
 * quedó sin respuesta. La frase vive en el piso, una sola vez.
 */
describe("whatsappMessenger — la pregunta tiene respuesta sin redactor", () => {
  const PREGUNTA = "¿Cuánto suele tardar esto?";
  const FALTAN = ["parte_amistoso", "licencia_conducir"];
  const veces = (s: string) => s.split(RESPUESTA_PENDIENTE).length - 1;
  const previo = process.env.AGENT_COMPOSE_REPLIES;

  afterEach(() => {
    if (previo === undefined) delete process.env.AGENT_COMPOSE_REPLIES;
    else process.env.AGENT_COMPOSE_REPLIES = previo;
  });

  function redactorCaido() {
    delete process.env.AGENT_COMPOSE_REPLIES;
    (callGemini as ReturnType<typeof vi.fn>).mockRejectedValue(
      new GeminiExtractionError("429", { status: 429, code: "RESOURCE_EXHAUSTED" })
    );
  }

  it("el pedido con pregunta la contesta una vez, con el redactor apagado", async () => {
    process.env.AGENT_COMPOSE_REPLIES = "off";
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: FALTAN,
      question: PREGUNTA,
    });

    expect(veces(sentBody())).toBe(1);
    expect(inserted[0]?.asked_keys).toEqual(FALTAN);
  });

  it("y con el redactor caído por un 429", async () => {
    redactorCaido();
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: FALTAN,
      question: PREGUNTA,
    });

    expect(veces(sentBody())).toBe(1);
    expect(inserted[0]?.asked_keys).toEqual(FALTAN);
  });

  it("el cierre con pregunta también, apagado y caído", async () => {
    process.env.AGENT_COMPOSE_REPLIES = "off";
    await send("confirmation_received", { caseId: CASE, question: PREGUNTA });
    expect(veces(sentBody())).toBe(1);

    resetSend();
    redactorCaido();
    await send("confirmation_received", { caseId: CASE, question: PREGUNTA });
    expect(veces(sentBody())).toBe(1);
  });

  it("el cierre con pregunta no promete contestar por el medio que cierra", async () => {
    process.env.AGENT_COMPOSE_REPLIES = "off";
    await send("confirmation_received", { caseId: CASE, isFollowUp: true, question: PREGUNTA });

    const body = sentBody();
    const tras = body.slice(body.indexOf(AVISO_DE_TRASPASO) + AVISO_DE_TRASPASO.length);
    expect(tras).toContain(RESPUESTA_PENDIENTE);
    expect(tras).not.toMatch(/por ac[aá]/i);
    expect(pideAlgo(tras.toLowerCase())).toBe(false);
  });

  // La frase también va en los pedidos, a mitad de la carga: ahí nadie
  // presentó a «la persona del equipo».
  it("el pedido con pregunta no nombra a una persona que nadie presentó", async () => {
    process.env.AGENT_COMPOSE_REPLIES = "off";
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: FALTAN,
      question: PREGUNTA,
    });

    expect(sentBody()).toContain(RESPUESTA_PENDIENTE);
    expect(sentBody()).not.toMatch(/\bla persona\b/i);
  });

  it.each(["missing_information_request", "confirmation_received"] as const)(
    "%s sin pregunta no la dice",
    async (template) => {
      process.env.AGENT_COMPOSE_REPLIES = "off";
      await send(template, { caseId: CASE, missingFields: FALTAN });
      expect(veces(sentBody())).toBe(0);
    }
  );
});

describe("whatsappMessenger — the record", () => {
  it("writes to the same ledger email writes to", async () => {
    await send("confirmation_received", { caseId: CASE });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      case_id: CASE,
      tenant_id: TENANT,
      channel: "whatsapp",
      template: "wa_confirmation_received",
      status: "sent",
    });
  });

  it("records a failed send as failed rather than pretending", async () => {
    (sendWhatsAppText as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    await send("confirmation_received", { caseId: CASE });

    expect(inserted[0]).toMatchObject({ status: "failed" });
  });

  it("never throws — the claim is already stored", async () => {
    (sendWhatsAppText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));

    await expect(send("confirmation_received", { caseId: CASE })).resolves.toBeUndefined();
  });
});

describe("messengerFor", () => {
  it("never sends a real message for a simulated case", async () => {
    // Simulation invents its phone numbers. Answering used to be the route's
    // job and that path simply never asked for a reply; now the orchestrator
    // answers every case, so the restraint has to live here.
    expect(messengerFor("whatsapp_sim")).toBe(simulatedWhatsappMessenger);

    await simulatedWhatsappMessenger.send({
      caseId: CASE,
      tenantId: TENANT,
      to: "5491100000000",
      template: "confirmation_received",
      data: { caseId: CASE },
    });

    expect(sendWhatsAppText).not.toHaveBeenCalled();
    // Still on the record, so an operator can read what it would have said.
    expect(inserted[0]).toMatchObject({ status: "skipped_simulated" });
  });

  it("routes the real channels to their own messengers", () => {
    expect(messengerFor("whatsapp")).toBe(whatsappMessenger);
    expect(messengerFor("email")).toBe(emailMessenger);
    expect(messengerFor("email_sim")).toBe(emailMessenger);
  });
});

/*
 * incendio-grave, 23/09: a quien tenía a su señora internada con quemaduras le
 * llegó una derivación de trámite. Con heridos, el piso abre con la frase de
 * cuidado; sin heridos, queda como estaba.
 */
describe("whatsappMessenger — la derivación con heridos", () => {
  const PREGUNTA = "¿Cuánto suele tardar esto?";
  const veces = (s: string, frase: string) => s.split(frase).length - 1;

  beforeEach(() => {
    (callGemini as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("sin modelo en tests"));
  });

  it("abre con la frase de cuidado y no pide nada", async () => {
    await send("specialist_escalation", { caseId: CASE, severity: "critical", heridos: true });

    const body = sentBody();
    expect(body.startsWith(CUIDADO)).toBe(true);
    expect(body).toContain("especialista");
    // Con el predicado del ensayo, más ancho que la guarda: el piso no puede
    // ponerlo en rojo.
    expect(pideAlgo(body.toLowerCase())).toBe(false);
    expect(hablaDeLaSalud(body)).toBe(false);
    // La consigna abre; el traspaso cierra.
    expect(body.indexOf(CUIDADO)).toBeLessThan(body.indexOf(AVISO_DE_TRASPASO));
    expect(mencionaElTraspaso(body)).toBe(true);
  });

  it("sin heridos, la derivación también avisa el traspaso", async () => {
    await send("specialist_escalation", { caseId: CASE, severity: "critical" });

    expect(sentBody()).toContain(AVISO_DE_TRASPASO);
    expect(mencionaElTraspaso(sentBody())).toBe(true);
  });

  it.each([
    ["sin heridos", {}],
    ["heridos: false", { heridos: false }],
    ["heridos como texto", { heridos: "true" }],
  ])("%s, el piso de siempre", async (_, extra) => {
    await send("specialist_escalation", { caseId: CASE, severity: "critical" });
    const deSiempre = sentBody();

    resetSend();
    await send("specialist_escalation", { caseId: CASE, severity: "critical", ...extra });

    expect(diceCuidado(sentBody())).toBe(false);
    expect(sentBody()).toBe(deSiempre);
  });

  it("con una pregunta, la frase una vez y la respuesta pendiente una vez, al final", async () => {
    await send("specialist_escalation", {
      caseId: CASE,
      severity: "high",
      heridos: true,
      question: PREGUNTA,
    });

    const body = sentBody();
    expect(veces(body, CUIDADO)).toBe(1);
    expect(veces(body, RESPUESTA_PENDIENTE)).toBe(1);
    expect(body.endsWith(`${RESPUESTA_PENDIENTE}\n\n${SI_VOLVES_A_ESCRIBIR}`)).toBe(true);
  });

  describe("con el redactor", () => {
    const BRIEF = "frase breve de cuidado";
    const redacta = (message: string) =>
      (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: JSON.stringify({ message }),
        usage: { promptTokens: 0, completionTokens: 0 },
      });
    const prompt = () => String((callGemini as ReturnType<typeof vi.fn>).mock.calls[0][0]);

    it("con heridos, la consigna llega al redactor", async () => {
      const redactado = `${CUIDADO} Ya derivamos tu denuncia a un especialista, que se va a comunicar con vos. ${AVISO_DE_TRASPASO}`;
      redacta(redactado);

      await send("specialist_escalation", { caseId: CASE, severity: "critical", heridos: true });

      expect(prompt()).toContain(BRIEF);
      expect(sentBody()).toBe(`${redactado}\n\n${SI_VOLVES_A_ESCRIBIR}`);
    });

    // El nombre que escribió la persona viaja en el piso del titular ajeno: un
    // «Lamentamos» ahí no es alguien que se lastimó.
    it("un nombre con «Lamentamos» no la prende en la del titular ajeno", async () => {
      const redactado = `Ya derivamos tu denuncia a un especialista, que se va a comunicar con vos. ${AVISO_DE_TRASPASO}`;
      redacta(redactado);

      await send("specialist_escalation", {
        caseId: CASE,
        titularIniciales: "R*** P***",
        claimantName: "Lamentamos Paz",
      });

      expect(prompt()).not.toContain(BRIEF);
      expect(sentBody()).toBe(`${redactado}\n\n${SI_VOLVES_A_ESCRIBIR}`);
    });
  });
});

/*
 * Un mensaje después del traspaso se suma al caso y queda en «Para responder».
 * El pie lo dice, y va fuera del redactor para que no dependa de que el modelo
 * se acuerde.
 */
describe("whatsappMessenger — después del traspaso", () => {
  const redacta = (message: string) =>
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ message }),
      usage: { promptTokens: 0, completionTokens: 0 },
    });
  const TITULAR_AJENO = {
    titularAjeno: true,
    fields: [{ fieldKey: "full_name", proposedValue: "Lucía Paz", conflictWithValue: "Roberto Paz" }],
  };

  beforeEach(() => {
    (callGemini as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("sin modelo en tests"));
  });

  it.each([
    ["confirmation_received", {}],
    ["specialist_escalation", { severity: "high" }],
    ["data_confirmation_request", TITULAR_AJENO],
  ] as const)("%s dice qué pasa si vuelve a escribir, y no pide nada", async (template, extra) => {
    await send(template, { caseId: CASE, ...extra });

    const body = sentBody();
    expect(body.endsWith(SI_VOLVES_A_ESCRIBIR)).toBe(true);
    expect(mencionaElTraspaso(body)).toBe(true);
    expect(pideAlgo(SI_VOLVES_A_ESCRIBIR.toLowerCase())).toBe(false);
  });

  it("también con la prosa del redactor, y en el simulado", async () => {
    const redactado = `Listo, tu denuncia quedó completa. ${AVISO_DE_TRASPASO}`;
    redacta(redactado);
    await send("confirmation_received", { caseId: CASE, isFollowUp: true });
    expect(sentBody()).toBe(`${redactado}\n\n${SI_VOLVES_A_ESCRIBIR}`);

    await simulatedWhatsappMessenger.send({
      caseId: CASE,
      tenantId: TENANT,
      to: TO,
      template: "confirmation_received",
      data: { caseId: CASE, isFollowUp: true },
    });
    expect(inserted[1]?.rendered_body).toBe(`${redactado}\n\n${SI_VOLVES_A_ESCRIBIR}`);
  });

  it.each([
    ["missing_information_request", { missingFields: ["parte_amistoso"] }],
    ["information_received", {}],
    [
      "data_confirmation_request",
      { fields: [{ fieldKey: "full_name", proposedValue: "Pedro García", conflictWithValue: "Juan Pérez" }] },
    ],
  ] as const)("%s sigue la carga por acá: sin pie", async (template, extra) => {
    await send(template, { caseId: CASE, ...extra });
    expect(sentBody()).not.toContain(SI_VOLVES_A_ESCRIBIR);
  });

  it("la derivación tras un pedido de confirmación dice que no hace falta contestarlo", async () => {
    const redactado = `Ya derivamos tu denuncia a un especialista. ${AVISO_DE_TRASPASO}`;
    redacta(redactado);
    await send("specialist_escalation", { caseId: CASE, severity: "high", yaPreguntamos: true });

    const body = sentBody();
    expect(body).toContain(NO_HACE_FALTA_CONTESTAR);
    expect(body.indexOf(AVISO_DE_TRASPASO)).toBeLessThan(body.indexOf(NO_HACE_FALTA_CONTESTAR));
    expect(pideAlgo(body.toLowerCase())).toBe(false);

    resetSend();
    redacta(redactado);
    await send("specialist_escalation", { caseId: CASE, severity: "high" });
    expect(sentBody()).not.toContain(NO_HACE_FALTA_CONTESTAR);
  });
});
