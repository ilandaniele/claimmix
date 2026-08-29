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

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  whatsappMessenger,
  simulatedWhatsappMessenger,
  messengerFor,
  emailMessenger,
} from "@/server/confirmations/messenger";
import { db } from "@/lib/db";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";
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

  it("never quotes an enum member back at a person", async () => {
    // On the email side, entendimos "other" reached a real inbox.
    await send("missing_information_request", {
      caseId: CASE,
      missingFields: ["claim_type"],
      knownValues: { claim_type: "other" },
    });

    const body = sentBody();
    expect(body).not.toContain("other");
    expect(body).toContain("• Tipo de siniestro");
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

  it("shows both values when ours disagrees with theirs", async () => {
    await send("data_confirmation_request", {
      caseId: CASE,
      fieldKey: "full_name",
      proposedValue: "Pedro García",
      conflictWithValue: "Juan Pérez",
    });

    const body = sentBody();
    expect(body).toContain("Pedro García");
    expect(body).toContain("Juan Pérez");
  });

  /*
   * Tres datos que no coinciden son un mensaje, no tres.
   *
   * Por WhatsApp era peor que por mail: tres notificaciones seguidas en el
   * teléfono de la persona, cada una diciendo casi lo mismo.
   */
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
    expect(body).toContain("Juan Pérez");
    expect(body).toContain("pedro@ejemplo.com");
    expect(body).toContain("juan@ejemplo.com");
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
