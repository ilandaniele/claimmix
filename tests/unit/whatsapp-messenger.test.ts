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
const TO = "59899413456";

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
