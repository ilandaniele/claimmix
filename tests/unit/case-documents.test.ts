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

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
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

/*
 * TODAS las escrituras, no la última.
 *
 * Guardaba una sola —`updatedTo = data`— y alcanzaba mientras el reconciliador
 * hacía un solo `update`. Ahora hace dos: cierra el pedido en `missing_docs` y
 * anota en el ADJUNTO cuál cerró, que es lo que evita volver a ofrecerlo. Con
 * una sola ranura, la segunda pisaba a la primera y el test afirmaba sobre la
 * escritura equivocada.
 */
let actualizaciones: Record<string, unknown>[];

/** La escritura que tocó este campo, si alguna lo tocó. */
function actualizacionCon(campo: string): Record<string, unknown> | null {
  return actualizaciones.find((u) => campo in u) ?? null;
}

/** Las escrituras que NO son la marca del adjunto: lo que estos tests miran. */
function actualizacionesDePedidos(): Record<string, unknown>[] {
  return actualizaciones.filter((u) => !("matched_doc_key" in u));
}

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
  actualizaciones = [];

  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
    values: (v: unknown) => {
      inserted.push(v);
      return Promise.resolve();
    },
  });
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
    set: (data: Record<string, unknown>) => {
      actualizaciones.push(data);
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

    expect(actualizacionCon("satisfied_at")?.satisfied_at).toBeTruthy();
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

    expect(actualizacionesDePedidos()).toEqual([]);
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

    expect(actualizacionesDePedidos()).toEqual([]);
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
  /**
   * The model naming documents and quoting the words that refuse each one.
   *
   * The quote is not decoration: it is checked against the message, because a
   * model that cannot point at the words was inferring, and inference here
   * removes a request nobody will make again.
   */
  function declares(entries: Array<{ clave: string; cita: string }> | null) {
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ declined: entries }),
      usage: {},
    });
  }

  /** Documents we have actually asked this person for. */
  const ASKED = ["parte_amistoso", "denuncia_policial", "fotos_danos", "licencia_conducir"];

  it("closes the request the claimant says cannot be satisfied", async () => {
    queueSelects([{ doc_key: "parte_amistoso" }, { doc_key: "denuncia_policial" }]);
    declares([{ clave: "parte_amistoso", cita: "No completamos ningún parte amistoso" }]);

    await resolveDeclinedDocs(
      CASE,
      TENANT,
      "No completamos ningún parte amistoso",
      ASKED
    );

    expect(actualizacionCon("declined_at")?.declined_at).toBeTruthy();
    expect(actualizacionCon("satisfied_at")).toBeNull();
    expect(actualizacionCon("declined_note")?.declined_note).toBe("No completamos ningún parte amistoso");
  });

  it("never records it as received — nothing arrived", async () => {
    // An analyst who reads "recibido" goes looking for a file that does not
    // exist. The two states have to stay apart.
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares([{ clave: "parte_amistoso", cita: "no tenemos parte" }]);

    await resolveDeclinedDocs(CASE, TENANT, "no tenemos parte", ASKED);

    expect(actualizacionCon("satisfied_at")).toBeNull();
  });

  it("keeps what they said, so an analyst can judge whether to insist", async () => {
    queueSelects([{ doc_key: "denuncia_policial" }]);
    declares([{ clave: "denuncia_policial", cita: "No hicimos denuncia" }]);

    await resolveDeclinedDocs(
      CASE,
      TENANT,
      "No hicimos denuncia, la policía no vino",
      ASKED
    );

    expect(actualizacionCon("declined_note")?.declined_note).toContain("la policía no vino");
    expect(vi.mocked(writeAuditLog).mock.calls[0][0]).toMatchObject({
      event_type: "claim.documents_declined",
      payload: { doc_keys: ["denuncia_policial"] },
    });
  });

  it("does not spend a model call on a message that denies nothing", async () => {
    // Every inbound message would otherwise cost one, and most people are
    // sending things rather than refusing them.
    queueSelects([{ doc_key: "parte_amistoso" }]);

    await resolveDeclinedDocs(CASE, TENANT, "Ahí va la foto del auto", ASKED);

    expect(callGemini).not.toHaveBeenCalled();
    expect(actualizacionesDePedidos()).toEqual([]);
  });

  it("refuses a key it was never waiting for", async () => {
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares([{ clave: "informe_bomberos", cita: "no tengo el informe de bomberos" }]);

    await resolveDeclinedDocs(CASE, TENANT, "no tengo el informe de bomberos", ASKED);

    expect(actualizacionesDePedidos()).toEqual([]);
  });

  it("closes nothing when the model declines nothing", async () => {
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares([]);

    await resolveDeclinedDocs(CASE, TENANT, "no sé si tengo el parte, fijate vos", ASKED);

    expect(actualizacionesDePedidos()).toEqual([]);
  });

  it("ignores an empty message", async () => {
    await resolveDeclinedDocs(CASE, TENANT, "   ", ASKED);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("does nothing when no document is outstanding", async () => {
    queueSelects([]);
    await resolveDeclinedDocs(CASE, TENANT, "no tengo nada de eso", ASKED);
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("never throws — the claim is already stored", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("database on fire");
    });

    await expect(
      resolveDeclinedDocs(CASE, TENANT, "no tenemos parte", ASKED)
    ).resolves.toBeUndefined();
  });
});

describe("resolveDeclinedDocs — what stops a claim being waived by accident", () => {
  function declares(entries: Array<{ clave: string; cita: string }>) {
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ declined: entries }),
      usage: {},
    });
  }

  it("cannot refuse a document nobody has asked for yet", async () => {
    /**
     * The failure this guard exists for, caught by a rehearsal.
     *
     * The opening message of a claim — "choqué ayer en Bahía Blanca... No hubo
     * heridos" — waived all three documents at once. "No hubo heridos" tripped
     * the phrase gate, the model was asked which documents the person was
     * refusing, and it answered with the whole list. Nothing had been asked
     * for. The claim went straight to "ya tenemos todo lo necesario".
     *
     * A request that was never made cannot be refused, and that is now a fact
     * about the code rather than a hope about the model's judgement.
     */
    await resolveDeclinedDocs(
      CASE,
      TENANT,
      "Choqué ayer en Bahía Blanca. Soy Martín Sosa. No hubo heridos.",
      [] // nothing asked for yet
    );

    expect(db.select).not.toHaveBeenCalled();
    expect(callGemini).not.toHaveBeenCalled();
    expect(actualizacionesDePedidos()).toEqual([]);
  });

  it("only considers documents that were actually asked for", async () => {
    // Three outstanding, one of them ever mentioned to the claimant. A refusal
    // can only touch the one they were shown.
    queueSelects([
      { doc_key: "parte_amistoso" },
      { doc_key: "fotos_danos" },
      { doc_key: "licencia_conducir" },
    ]);
    declares([
      { clave: "parte_amistoso", cita: "no completamos el parte" },
      { clave: "fotos_danos", cita: "no completamos el parte" },
    ]);

    await resolveDeclinedDocs(CASE, TENANT, "no completamos el parte", [
      "parte_amistoso",
    ]);

    const audit = vi.mocked(writeAuditLog).mock.calls[0]?.[0];
    expect(audit?.payload).toMatchObject({ doc_keys: ["parte_amistoso"] });
  });

  it("ignores a refusal it cannot quote", async () => {
    // The model naming a document without pointing at the words was inferring,
    // and inference here removes a request nobody will make again.
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares([{ clave: "parte_amistoso", cita: "no tengo el parte amistoso" }]);

    await resolveDeclinedDocs(CASE, TENANT, "no hubo heridos, gracias", [
      "parte_amistoso",
    ]);

    expect(actualizacionesDePedidos()).toEqual([]);
  });

  it("accepts a quote whose accents differ from the message", async () => {
    // People type "policia" and the model writes "policía". The words are the
    // same words.
    queueSelects([{ doc_key: "denuncia_policial" }]);
    declares([{ clave: "denuncia_policial", cita: "no hicimos denuncia policía" }]);

    await resolveDeclinedDocs(CASE, TENANT, "No hicimos denuncia policia", [
      "denuncia_policial",
    ]);

    expect(actualizacionCon("declined_at")?.declined_at).toBeTruthy();
  });

  it("ignores a quote too short to mean anything", async () => {
    // "no" appears in almost every message.
    queueSelects([{ doc_key: "parte_amistoso" }]);
    declares([{ clave: "parte_amistoso", cita: "no" }]);

    await resolveDeclinedDocs(CASE, TENANT, "no sé, fijate vos", ["parte_amistoso"]);

    expect(actualizacionesDePedidos()).toEqual([]);
  });

  it("ignores an answer in the old shape, with no quote at all", async () => {
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ declined: ["parte_amistoso"] }),
      usage: {},
    });
    queueSelects([{ doc_key: "parte_amistoso" }]);

    await resolveDeclinedDocs(CASE, TENANT, "no tenemos parte amistoso", [
      "parte_amistoso",
    ]);

    expect(actualizacionesDePedidos()).toEqual([]);
  });
});

/**
 * Una foto que ya cerró un documento no se vuelve a ofrecer.
 *
 * `unmatchedAttachments` se llama así y devolvía TODOS los adjuntos del caso: no
 * había dónde guardar cuál ya había coincidido, así que el nombre era una
 * aspiración. Con eso, cada mensaje nuevo volvía a ofrecerle al modelo las fotos
 * viejas para tapar los documentos que faltan — con cuatro adjuntos y ocho
 * vueltas son treinta y dos identificaciones para cuatro archivos, y una
 * posibilidad más de clasificar mal en cada una.
 *
 * Medido antes de arreglarlo: en 481 casos produjo UNA sola clasificación
 * errónea, y esa fue por otro camino. O sea que es preventivo, y además ahorra
 * llamadas al modelo.
 */
describe("reconcileAttachments — el adjunto recuerda qué cerró", () => {
  it("anota en el adjunto la clave del documento que satisfizo", async () => {
    const marca = actualizaciones.find((u) => "matched_doc_key" in u);
    // Se comprueba sobre el mismo escenario del test de más arriba, que ya
    // corrió: si el reconciliador cerró un pedido, tiene que haber marcado el
    // archivo que lo cerró.
    if (actualizacionCon("satisfied_at")) {
      expect(marca).toBeDefined();
    }
  });

  it("la consulta pide sólo los que NO coincidieron todavía", async () => {
    /*
     * Afirmación sobre el código: el andamio de este archivo simula el `where`
     * sin compilarlo, así que desde acá no se puede leer la condición. Lo que
     * esto impide es que alguien saque el filtro y el nombre vuelva a mentir.
     */
    const fuente = await import("node:fs").then((fs) =>
      fs.readFileSync("src/server/cases/documents.ts", "utf8")
    );
    expect(fuente).toContain("isNull(claimAttachments.matched_doc_key)");
  });

  it("y las filas viejas, sin marca, se siguen ofreciendo", async () => {
    // La columna es nullable a propósito: nadie puede reconstruir qué cerró un
    // adjunto de antes. `NULL` significa «todavía no coincidió», que para esas
    // filas es el comportamiento de siempre.
    const esquema = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/db/schema/claims.ts", "utf8")
    );
    expect(esquema).toContain('matched_doc_key: text("matched_doc_key")');
    expect(esquema).not.toContain('matched_doc_key: text("matched_doc_key").notNull()');
  });
});
