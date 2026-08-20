/**
 * Asking for the papers a claim needs, and noticing when they arrive.
 *
 * Three separate silences met here. `required_docs_config` was seeded at the
 * start of the project and read by nothing, so nobody was ever asked for the
 * photos of the damage. The ask list was built from fields, and a document is
 * not a field. And `satisfied_at` was only ever written by an analyst
 * clicking, so a person could send exactly the photo we wanted and be asked
 * for it again next round.
 *
 * The direction of caution matters and is asserted below: a document wrongly
 * marked as received vanishes from the analyst's list and nobody finds out
 * until the claim stalls. One asked for twice is a nuisance.
 */

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    DOCUMENTS_RECEIVED: "claim.documents_received",
    DOCUMENTS_DECLINED: "claim.documents_declined",
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  seedRequiredDocs,
  pendingDocKeys,
  reconcileAttachments,
  resolveDeclinedDocs,
} from "@/server/cases/documents";
import { db } from "@/lib/db";
import { callGemini } from "@/server/ai/gemini-extractor";
import { writeAuditLog } from "@/lib/audit/log";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";

let inserted: unknown[];
let updatedTo: Record<string, unknown> | null;

/** Queue results for the selects, in the order the module issues them. */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted = [];
  updatedTo = null;

  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
    values: (v: unknown) => {
      inserted.push(v);
      return Promise.resolve();
    },
  });
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
    set: (data: Record<string, unknown>) => {
      updatedTo = data;
      return { where: () => Promise.resolve() };
    },
  });
});

describe("seedRequiredDocs", () => {
  it("registers the documents the tenant configured for this claim type", async () => {
    // The config table has been there all along and nothing read it.
    queueSelects(
      [{ doc_key: "fotos_danos" }, { doc_key: "parte_amistoso" }],
      [] // nothing recorded on the case yet
    );

    await seedRequiredDocs(CASE, TENANT, "choque");

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual([
      { case_id: CASE, tenant_id: TENANT, doc_key: "fotos_danos", satisfied_at: null },
      { case_id: CASE, tenant_id: TENANT, doc_key: "parte_amistoso", satisfied_at: null },
    ]);
  });

  it("does not resurrect a document already recorded", async () => {
    // Re-extraction runs on every reply; re-inserting would reopen a request
    // the claimant already satisfied.
    queueSelects(
      [{ doc_key: "fotos_danos" }, { doc_key: "parte_amistoso" }],
      [{ doc_key: "fotos_danos" }]
    );

    await seedRequiredDocs(CASE, TENANT, "choque");

    expect(inserted[0]).toEqual([
      { case_id: CASE, tenant_id: TENANT, doc_key: "parte_amistoso", satisfied_at: null },
    ]);
  });

  it("does nothing until the claim type is known", async () => {
    await seedRequiredDocs(CASE, TENANT, null);
    expect(db.select).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe("pendingDocKeys", () => {
  it("returns files to send, not facts to type", async () => {
    // missing_docs also holds low-confidence field keys. Asking for
    // `hora_siniestro` as an attachment is the old snake_case bug in reverse.
    queueSelects([
      { doc_key: "fotos_danos" },
      { doc_key: "hora_siniestro" },
      { doc_key: "denuncia_policial" },
      { doc_key: "telefono_contacto" },
    ]);

    expect(await pendingDocKeys(CASE, TENANT)).toEqual([
      "fotos_danos",
      "denuncia_policial",
    ]);
  });
});

describe("reconcileAttachments", () => {
  function identifiesAs(key: string | null) {
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ doc_key: key }),
      usage: {},
    });
  }

  it("closes the request the arriving photo satisfies", async () => {
    queueSelects(
      [{ doc_key: "fotos_danos" }, { doc_key: "denuncia_policial" }],
      [
        {
          id: "att-1",
          filename: "image-abc.jpg",
          contentType: "image/jpeg",
          storagePath: null,
        },
      ]
    );
    identifiesAs("fotos_danos");

    await reconcileAttachments(CASE, TENANT, "choque de vehículo");

    expect(updatedTo?.satisfied_at).toBeTruthy();
    expect(vi.mocked(writeAuditLog).mock.calls[0][0]).toMatchObject({
      event_type: "claim.documents_received",
      payload: { doc_keys: ["fotos_danos"] },
    });
  });

  it("leaves everything open when it cannot tell what the file is", async () => {
    queueSelects(
      [{ doc_key: "fotos_danos" }],
      [{ id: "att-1", filename: "IMG_0042.jpg", contentType: "image/jpeg", storagePath: null }]
    );
    identifiesAs(null);

    await reconcileAttachments(CASE, TENANT, null);

    expect(updatedTo).toBeNull();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a key it was never waiting for", async () => {
    // A model that invents a document must not close a request that does not
    // exist, nor one from another claim type.
    queueSelects(
      [{ doc_key: "fotos_danos" }],
      [{ id: "att-1", filename: "x.jpg", contentType: "image/jpeg", storagePath: null }]
    );
    identifiesAs("informe_bomberos");

    await reconcileAttachments(CASE, TENANT, null);

    expect(updatedTo).toBeNull();
  });

  it("does not call the model when nothing is outstanding", async () => {
    queueSelects([]);

    await reconcileAttachments(CASE, TENANT, null);

    expect(callGemini).not.toHaveBeenCalled();
  });

  it("does not call the model when nothing arrived", async () => {
    queueSelects([{ doc_key: "fotos_danos" }], []);

    await reconcileAttachments(CASE, TENANT, null);

    expect(callGemini).not.toHaveBeenCalled();
  });

  it("never throws — the claim is already stored", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("database on fire");
    });

    await expect(reconcileAttachments(CASE, TENANT, null)).resolves.toBeUndefined();
  });
});

describe("resolveDeclinedDocs", () => {
  /**
   * Most crashes have no friendly accident report — our own message says "si
   * lo completaron" — and "no completamos ninguno" was heard as silence. The
   * request stayed open, every round asked for it again, and the case sat in
   * confirmacion_pendiente until the abandonment sweep closed it two weeks
   * later as though the claimant had never replied.
   */
  function declares(keys: string[] | null) {
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ declined: keys }),
      usage: {},
    });
  }

  it("closes the request the claimant says cannot be satisfied", async () => {
    queueSelects([{ doc_key: "parte_amistoso" }, { doc_key: "denuncia_policial" }]);
    declares(["parte_amistoso"]);

    await resolveDeclinedDocs(CASE, TENANT, "No completamos ningún parte amistoso");

    expect(updatedTo?.declined_at).toBeTruthy();
    expect(updatedTo?.satisfied_at).toBeUndefined();
    expect(updatedTo?.declined_note).toBe("No completamos ningún parte amistoso");
  });

  it("never records it as received — nothing arrived", async () => {
    // An analyst who reads "recibido" goes looking for a file that does not
    // exist. The two states have to stay apart.
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares(["parte_amistoso"]);

    await resolveDeclinedDocs(CASE, TENANT, "no tenemos parte");

    expect(Object.keys(updatedTo ?? {})).not.toContain("satisfied_at");
  });

  it("keeps what they said, so an analyst can judge whether to insist", async () => {
    queueSelects([{ doc_key: "denuncia_policial" }]);
    declares(["denuncia_policial"]);

    await resolveDeclinedDocs(CASE, TENANT, "No hicimos denuncia, la policía no vino");

    expect(updatedTo?.declined_note).toContain("la policía no vino");
    expect(vi.mocked(writeAuditLog).mock.calls[0][0]).toMatchObject({
      event_type: "claim.documents_declined",
      payload: { doc_keys: ["denuncia_policial"] },
    });
  });

  it("does not spend a model call on a message that denies nothing", async () => {
    // Every inbound message would otherwise cost one, and most people are
    // sending things rather than refusing them.
    queueSelects([{ doc_key: "parte_amistoso" }]);

    await resolveDeclinedDocs(CASE, TENANT, "Ahí va la foto del auto");

    expect(callGemini).not.toHaveBeenCalled();
    expect(updatedTo).toBeNull();
  });

  it("refuses a key it was never waiting for", async () => {
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares(["informe_bomberos"]);

    await resolveDeclinedDocs(CASE, TENANT, "no tengo el informe de bomberos");

    expect(updatedTo).toBeNull();
  });

  it("closes nothing when the model declines nothing", async () => {
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares([]);

    await resolveDeclinedDocs(CASE, TENANT, "no sé si tengo el parte, fijate vos");

    expect(updatedTo).toBeNull();
  });

  it("ignores an empty message", async () => {
    await resolveDeclinedDocs(CASE, TENANT, "   ");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("does nothing when no document is outstanding", async () => {
    queueSelects([]);
    await resolveDeclinedDocs(CASE, TENANT, "no tengo nada de eso");
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("never throws — the claim is already stored", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("database on fire");
    });

    await expect(
      resolveDeclinedDocs(CASE, TENANT, "no tenemos parte")
    ).resolves.toBeUndefined();
  });
});
