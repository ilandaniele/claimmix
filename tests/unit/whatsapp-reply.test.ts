/**
 * Deciding what to say back on WhatsApp — and when to say nothing.
 *
 * Two failure modes matter here and neither is a crash. Answering a message the
 * agent correctly rejected as not-a-claim spends a paid conversation and tells
 * a spammer someone is home. Staying silent on a real claim leaves the person
 * who just crashed their car with no confirmation that anyone received it.
 */

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock("@/server/whatsapp/cloud-api", () => ({
  sendWhatsAppText: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { replyToWhatsAppIntake } from "@/server/whatsapp/notify";
import { db } from "@/lib/db";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";
const TO = "59899413456";

/**
 * The module issues selects in a fixed order (case, then pending docs, then
 * labels), so the mock just hands back queued results. The chain is awaitable
 * both with and without `.limit()`, matching how the queries are written.
 */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const rows = queue.shift() ?? [];
    const where = () => {
      const p: Promise<unknown[]> & { limit?: () => Promise<unknown[]> } =
        Promise.resolve(rows);
      p.limit = () => Promise.resolve(rows);
      return p;
    };
    return { from: () => ({ where }) };
  });
}

let inserted: Record<string, unknown>[];
let updated: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  inserted = [];
  updated = false;

  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return Promise.resolve();
    },
  });
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
    set: () => ({
      where: () => {
        updated = true;
        return Promise.resolve();
      },
    }),
  });
  (sendWhatsAppText as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
});

describe("replyToWhatsAppIntake", () => {
  it("says nothing when the agent decided it is not a claim", async () => {
    queueSelects([{ is_claim: false, claim_type: null }]);

    const r = await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(r).toEqual({ sent: false, reason: "not_a_claim" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    // No ledger row either — nothing was said.
    expect(inserted).toHaveLength(0);
  });

  it("acknowledges a complete claim without inventing a document request", async () => {
    queueSelects([{ is_claim: true, claim_type: "choque" }], []);

    const r = await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(r.sent).toBe(true);
    expect(r.template).toBe("wa_ack_complete");
    const [, body] = (sendWhatsAppText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toContain("Recibimos tu denuncia");
    expect(body).not.toContain("•");
  });

  it("lists the missing documents using their human labels", async () => {
    queueSelects(
      [{ is_claim: true, claim_type: "cristales" }],
      [{ doc_key: "vtv" }, { doc_key: "foto_vidrio" }],
      [
        { doc_key: "vtv", label_es: "Oblea de la VTV" },
        { doc_key: "foto_vidrio", label_es: "Foto del vidrio roto" },
      ]
    );

    const r = await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(r.template).toBe("wa_ack_missing_docs");
    const [, body] = (sendWhatsAppText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toContain("• Oblea de la VTV");
    expect(body).toContain("• Foto del vidrio roto");
    // Never leak the internal key when a label exists.
    expect(body).not.toContain("foto_vidrio");
  });

  it("falls back to the raw key rather than dropping a document silently", async () => {
    // A doc with no row in required_docs_config: asking awkwardly beats not
    // asking, because an unasked document stalls the claim forever.
    queueSelects(
      [{ is_claim: true, claim_type: "choque" }],
      [{ doc_key: "constancia_rara" }],
      []
    );

    await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    const [, body] = (sendWhatsAppText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toContain("• constancia_rara");
  });

  it("asks for at most five things, not the thirteen extraction found", async () => {
    // A real claim came back with thirteen gaps. Sending someone who just
    // crashed their car a list of thirteen demands gets no reply at all.
    const keys = Array.from({ length: 13 }, (_, i) => ({ doc_key: `doc_${i}` }));
    queueSelects([{ is_claim: true, claim_type: "choque" }], keys, []);

    await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    const [, body] = (sendWhatsAppText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((body.match(/•/g) ?? []).length).toBe(5);
    expect(body).toContain("Para empezar");
    expect(body).toContain("Después te pedimos el resto");
  });

  it("does not promise a follow-up when everything fits in one message", async () => {
    queueSelects(
      [{ is_claim: true, claim_type: "choque" }],
      [{ doc_key: "dni" }, { doc_key: "vtv" }],
      []
    );

    await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    const [, body] = (sendWhatsAppText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((body.match(/•/g) ?? []).length).toBe(2);
    expect(body).not.toContain("Después te pedimos el resto");
  });

  it("marks the requested documents so a later reminder does not repeat them", async () => {
    queueSelects(
      [{ is_claim: true, claim_type: "choque" }],
      [{ doc_key: "dni" }],
      [{ doc_key: "dni", label_es: "Foto del DNI" }]
    );

    await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(updated).toBe(true);
  });

  it("does not mark anything when there was nothing to request", async () => {
    queueSelects([{ is_claim: true, claim_type: "choque" }], []);

    await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(updated).toBe(false);
  });

  it("promises nothing specific when extraction produced no verdict", async () => {
    // is_claim null = failed or escalated. We do not know what this is yet.
    queueSelects([{ is_claim: null, claim_type: null }]);

    const r = await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(r.template).toBe("wa_ack_received");
    const [, body] = (sendWhatsAppText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toContain("Recibimos tu mensaje");
    expect(body).not.toContain("denuncia");
  });

  it("records every send in the outbound ledger, same as email", async () => {
    queueSelects([{ is_claim: true, claim_type: "choque" }], []);

    await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      case_id: CASE,
      tenant_id: TENANT,
      channel: "whatsapp",
      template: "wa_ack_complete",
      status: "sent",
    });
    expect(inserted[0].rendered_body).toContain("Recibimos");
  });

  it("records a failed send as failed instead of pretending it went out", async () => {
    queueSelects([{ is_claim: true, claim_type: "choque" }], []);
    (sendWhatsAppText as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    const r = await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(r).toMatchObject({ sent: false, reason: "send_failed" });
    expect(inserted[0]).toMatchObject({ status: "failed" });
    // A send that failed must not claim the documents were requested.
    expect(updated).toBe(false);
  });

  it("reports a missing case instead of messaging a stranger", async () => {
    queueSelects([]);

    const r = await replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO });

    expect(r).toEqual({ sent: false, reason: "case_not_found" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("never throws — intake already succeeded and must not be undone", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("database on fire");
    });

    await expect(
      replyToWhatsAppIntake({ caseId: CASE, tenantId: TENANT, to: TO })
    ).resolves.toEqual({ sent: false, reason: "error" });
  });
});
