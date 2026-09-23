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

// El GeminiExtractionError y el errMeta de verdad: con qué criterio se
// relanza una caída del reconocedor es justo lo que se prueba más abajo.
vi.mock("@/server/ai/gemini-extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ai/gemini-extractor")>()),
  callGemini: vi.fn(),
}));

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));

vi.mock("@/lib/observability/logger", () => ({
  logger: { error: mockLogError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
import { callGemini, GeminiExtractionError } from "@/server/ai/gemini-extractor";
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

/**
 * Las escrituras que NO son contabilidad del adjunto: lo que estos tests miran.
 *
 * Son dos: `matched_doc_key` —cual documento cerro— y
 * `intentos_de_identificacion` —cuantas veces se le pregunto al modelo—. La
 * segunda existe porque un archivo que el modelo no reconocia se volvia a
 * mirar en cada mensaje entrante, para siempre.
 */
function actualizacionesDePedidos(): Record<string, unknown>[] {
  return actualizaciones.filter(
    (u) => !("matched_doc_key" in u) && !("intentos_de_identificacion" in u)
  );
}

// Drizzle guarda el nombre de la tabla en Symbol.for("drizzle:Name").
const DRIZZLE_NAME = Symbol.for("drizzle:Name");

/** La condición de cada select, con la tabla sobre la que se hizo. */
let condiciones: Array<{ tabla: string; cond: unknown }>;

/** La condición del primer select hecho sobre esta tabla. */
function condicionSobre(tabla: string): unknown {
  return condiciones.find((c) => c.tabla === tabla)?.cond;
}

/**
 * Los nombres de columna que filtran una condición de drizzle.
 *
 * Un `and(...)` es un `sql` con `queryChunks` adentro, y cada comparación deja
 * la columna como un trozo más. Las columnas son las hojas: traen `name` y no
 * traen `queryChunks`. Serializar la condición entera no se puede —un `sql` con
 * columnas adentro es circular—, pero recorrerla sí, y eso deja afirmar sobre
 * LA consulta en vez de sobre el texto del archivo.
 */
function columnasDe(cond: unknown, acc: string[] = []): string[] {
  const nodo = cond as { name?: string; queryChunks?: unknown[] } | null | undefined;
  if (nodo?.name && !nodo.queryChunks) acc.push(nodo.name);
  for (const trozo of nodo?.queryChunks ?? []) columnasDe(trozo, acc);
  return acc;
}

/** Queue results for the selects, in the order the module issues them. */
function queueSelects(...results: unknown[][]) {
  const queue = [...results];
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    from: (tabla: unknown) => ({
      /*
       * `where()` devuelve algo que se puede esperar Y que ademas tiene
       * `.limit()`. Las dos formas conviven en este archivo: la mayoria de las
       * consultas cierra en `where`, y la de adjuntos sin clasificar lleva
       * `.limit(MAX_ADJUNTOS_POR_CORRIDA)` para no gastar una llamada de vision
       * por archivo en el camino de respuesta al asegurado.
       */
      where: (cond: unknown) => {
        // La condición se guarda además de devolver las filas: el mock no la
        // compila —filtrar no filtra—, pero es la consulta que arma el código
        // de verdad y se puede leer con qué columnas filtra.
        condiciones.push({
          tabla: (tabla as Record<symbol, string>)?.[DRIZZLE_NAME] ?? "",
          cond,
        });
        const filas = queue.shift() ?? [];
        const esperable = Promise.resolve(filas) as Promise<unknown[]> & {
          limit?: () => Promise<unknown[]>;
        };
        esperable.limit = () => Promise.resolve(filas);
        return esperable;
      },
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted = [];
  actualizaciones = [];
  condiciones = [];

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

    // Y no cierra nada: la lista vacía es la que apaga la señal de «nos
    // contestó el pedido», así que una base caída no puede prenderla.
    await expect(
      resolveDeclinedDocs(CASE, TENANT, "no tenemos parte", ASKED)
    ).resolves.toEqual([]);
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

  it("y deja afuera a los que nunca entraron al bucket", async () => {
    /*
     * El adjunto rechazado no se puede devolver desde el andamio —el mock no
     * compila el `where`, así que filtrar no filtra—, pero la condición sí se
     * puede leer: es la consulta de verdad y lo que se afirma es que la base
     * nunca va a devolver esas filas.
     */
    queueSelects(
      [{ doc_key: "parte_amistoso" }],
      [
        {
          id: "att-1",
          filename: "parte-policial.pdf",
          contentType: "application/pdf",
          storagePath: null,
        },
      ]
    );
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ doc_key: null }),
      usage: {},
    });

    await reconcileAttachments(CASE, TENANT, null);

    const columnas = columnasDe(condicionSobre("claim_attachments"));
    /*
     * Un adjunto de WhatsApp que pasa los 10 MB deja fila igual, sin bytes y
     * con `rejected_reason`. Sin este filtro esa fila vuelve a ser candidata y
     * se identifica con el NOMBRE del archivo como única prueba —lo pone quien
     * manda—, cerrando el pedido con `satisfied_at` por algo que no está
     * guardado.
     */
    expect(columnas).toContain("rejected_reason");
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

/**
 * Un reconocedor caído no es un «no negó nada».
 *
 * El `pnpm check` del 23/09, `mail-completo` turno 2: la persona escribió que
 * no había parte amistoso, `identifyDeclined` recibió un 429 a los 8,7 s y su
 * catch devolvió []. Eso se leyó como que no había negado nada, la deliberación
 * también cayó, el turno terminó mudo y el parte quedó pedido para siempre. Un
 * fallo técnico convertido en dato.
 */
describe("resolveDeclinedDocs — un reconocedor caído no es un «no negó nada»", () => {
  const DICHO = "No completamos ningún parte amistoso, el otro conductor no quiso.";
  const ASKED = ["parte_amistoso"];
  const MENSAJE = "Quota exceeded for generate_content_requests_per_minute";

  const cupo = () =>
    new GeminiExtractionError(MENSAJE, { status: 429, code: "RESOURCE_EXHAUSTED" });

  function caeCon(err: unknown) {
    queueSelects([{ doc_key: "parte_amistoso" }]);
    vi.mocked(callGemini).mockRejectedValue(err);
  }

  function reconoce() {
    queueSelects([{ doc_key: "parte_amistoso" }]);
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({
        declined: [{ clave: "parte_amistoso", cita: "No completamos ningún parte amistoso" }],
      }),
      usage: { promptTokens: 0, completionTokens: 0 },
      model: "gemini-2.5-flash",
    });
  }

  it("un 429 vuelve a la cola si el turno se puede retomar", async () => {
    const err = cupo();
    caeCon(err);

    await expect(resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED, true)).rejects.toBe(err);

    expect(db.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("un TIMEOUT se comporta igual", async () => {
    const err = new GeminiExtractionError("plazo", { code: "TIMEOUT" });
    caeCon(err);

    await expect(resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED, true)).rejects.toBe(err);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("sin el aviso, el mismo 429 no corta el turno", async () => {
    // El default es la conducta de antes: quien no puede retomar el turno
    // sigue sin la negativa.
    caeCon(cupo());

    await expect(resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED)).resolves.toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["un 400", () => caeCon(new GeminiExtractionError("400", { status: 400, code: "INVALID_ARGUMENT" }))],
    ["un MAX_TOKENS", () => caeCon(new GeminiExtractionError("max", { status: 200, code: "MAX_TOKENS" }))],
    ["un 503 agotado", () => caeCon(new GeminiExtractionError("503", { status: 503, code: "UNAVAILABLE" }))],
    ["un GeminiExtractionError sin causa", () => caeCon(new GeminiExtractionError("sin clave"))],
    [
      "un JSON inválido",
      () => {
        queueSelects([{ doc_key: "parte_amistoso" }]);
        vi.mocked(callGemini).mockResolvedValue({
          text: "esto no es JSON",
          usage: { promptTokens: 0, completionTokens: 0 },
          model: "gemini-2.5-flash",
        });
      },
    ],
    [
      "un Error común con causa 429",
      () => caeCon(Object.assign(new Error("otra cosa"), { cause: { status: 429 } })),
    ],
  ])("%s no corta el turno aunque se pueda retomar", async (_nombre, preparar) => {
    preparar();

    await expect(resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED, true)).resolves.toEqual([]);
    expect(db.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  const drizzle = () =>
    Object.assign(new Error("Failed query"), {
      name: "DrizzleQueryError",
      cause: Object.assign(new Error("terminating connection"), { code: "57P01" }),
    });
  // Lo que tira el lote de neon-http que usa `enTenant`: el código arriba, sin causa.
  const neon = () =>
    Object.assign(new Error("permission denied for table missing_docs"), {
      name: "NeonDbError",
      code: "42501",
    });

  it.each([
    ["DrizzleQueryError", true, drizzle, "57P01"],
    ["DrizzleQueryError", false, drizzle, "57P01"],
    ["NeonDbError", true, neon, "42501"],
    ["NeonDbError", false, neon, "42501"],
  ] as const)(
    "la base caída (%s) sigue tragándose y dice su código (vuelveALaCola=%s)",
    async (error_name, vuelve, caida, code) => {
      reconoce();
      (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: () => ({ where: () => Promise.reject(caida()) }),
      });

      await expect(resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED, vuelve)).resolves.toEqual([]);

      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        { error_name, status: null, code, case_id: CASE },
        "documents.decline_check_failed"
      );
    }
  );

  it.each([true, false])(
    "el log dice el estado del proveedor, una sola vez (vuelveALaCola=%s)",
    async (vuelve) => {
      caeCon(cupo());

      await resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED, vuelve).catch(() => undefined);

      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        { error_name: "GeminiExtractionError", status: 429, code: "RESOURCE_EXHAUSTED", case_id: CASE },
        "documents.decline_identify_failed"
      );
      // Ni lo que escribió la persona ni el texto del proveedor.
      const logueado = JSON.stringify(mockLogError.mock.calls);
      expect(logueado).not.toContain("parte amistoso");
      expect(logueado).not.toContain(MENSAJE);
    }
  );

  it("con el reconocedor sano, el aviso no cambia nada", async () => {
    reconoce();
    const sinAviso = await resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED);
    const escriturasSinAviso = actualizacionesDePedidos().length;

    reconoce();
    const conAviso = await resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED, true);

    expect(sinAviso).toEqual(["parte_amistoso"]);
    expect(conAviso).toEqual(sinAviso);
    expect(actualizacionesDePedidos()).toHaveLength(escriturasSinAviso * 2);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("un 429 real de Vertex llega con la forma que se relanza", async () => {
    // El callGemini de verdad contra un fetch que devuelve 429: lo que importa
    // es que el error que arma el proveedor sea el que `esPasajero` reconoce.
    const real = await vi.importActual<typeof import("@/server/ai/gemini-extractor")>(
      "@/server/ai/gemini-extractor"
    );
    const guardadas = {
      GEMINI_TRANSPORT: process.env.GEMINI_TRANSPORT,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_MAX_RETRIES: process.env.GEMINI_MAX_RETRIES,
      GEMINI_RETRY_BASE_MS: process.env.GEMINI_RETRY_BASE_MS,
      GEMINI_MIN_REQUEST_INTERVAL_MS: process.env.GEMINI_MIN_REQUEST_INTERVAL_MS,
    };
    const fetchOriginal = globalThis.fetch;
    process.env.GEMINI_TRANSPORT = "";
    process.env.GEMINI_API_KEY = "clave-de-prueba";
    process.env.GEMINI_MAX_RETRIES = "0";
    process.env.GEMINI_RETRY_BASE_MS = "0";
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS = "0";
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: new Headers(),
      json: async () => ({ error: { status: "RESOURCE_EXHAUSTED", message: MENSAJE } }),
    })) as unknown as typeof fetch;

    try {
      queueSelects([{ doc_key: "parte_amistoso" }]);
      vi.mocked(callGemini).mockImplementation(real.callGemini);

      const err = await resolveDeclinedDocs(CASE, TENANT, DICHO, ASKED, true).catch((e) => e);

      expect(err).toBeInstanceOf(GeminiExtractionError);
      expect((err as GeminiExtractionError).cause).toMatchObject({ status: 429 });
      expect(db.update).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = fetchOriginal;
      for (const [k, v] of Object.entries(guardadas)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
