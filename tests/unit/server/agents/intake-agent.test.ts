import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- hoisted mocks ----------
const {
  mockRunEmailExtractionWorker,
  mockWriteAuditLog,
  mockDbSelect,
  mockDbInsert,
  mockMarcarParaResponder,
  mockMarcarAunqueSiga,
  mockDownloadMedia,
  mockCredenciales,
  mockRehost,
} = vi.hoisted(() => ({
  mockDownloadMedia: vi.fn(),
  mockCredenciales: vi.fn(),
  mockRehost: vi.fn(),
  mockMarcarParaResponder: vi.fn(),
  mockMarcarAunqueSiga: vi.fn(),
  mockRunEmailExtractionWorker: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  // select chain: .select().from().where().orderBy().limit()
  mockDbSelect: vi.fn(),
  // insert chain: .insert().values().returning()
  mockDbInsert: vi.fn(),
}));

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
vi.mock("@/data/scope", () => import("../../../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => {
  // Chainable select builder.
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  mockDbSelect.mockReturnValue(selectChain);

  // Chainable insert builder.
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    // insert().values() without .returning() is also called (for claimMessages, rawMessages)
    // so values() itself needs to be awaitable when not followed by returning().
    // We handle this by making returning() resolve and also making the chain thenable.
    then: undefined as unknown,
  };
  // Make insertChain.values also directly awaitable (Promise-like) for inserts without .returning().
  const valuesChain = {
    returning: vi.fn().mockResolvedValue([]),
  };
  // We'll override per-test; provide a sensible default.
  insertChain.values.mockReturnValue(valuesChain);
  mockDbInsert.mockReturnValue(insertChain);

  return {
    db: {
      select: (...args: unknown[]) => mockDbSelect(...args),
      insert: (...args: unknown[]) => mockDbInsert(...args),
    },
    tables: {
      cases: {
        id: "id",
        tenant_id: "tenant_id",
        channel: "channel",
        status: "status",
        email_thread_id: "email_thread_id",
        created_at: "created_at",
      },
      claimMessages: {},
      rawMessages: {},
    },
  };
});

vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
}));

vi.mock("@/server/cases/para-responder", () => ({
  marcarParaResponder: mockMarcarParaResponder,
  marcarParaResponderAunqueSigaElAgente: mockMarcarAunqueSiga,
}));

vi.mock("@/server/worker/extract", () => ({
  runEmailExtractionWorker: mockRunEmailExtractionWorker,
}));

vi.mock("@/server/whatsapp/cloud-api", () => ({
  downloadWhatsAppMedia: mockDownloadMedia,
}));

vi.mock("@/server/whatsapp/numeros", () => ({
  credencialesWhatsApp: mockCredenciales,
  avisarSinNumero: vi.fn(),
}));

vi.mock("@/server/email/rehost-attachments", () => ({
  rehostAndRecordAttachments: mockRehost,
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: {
    EMAIL_RECEIVED: "email.received",
    MESSAGE_NOT_READ: "claim.message_not_read",
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { clearAllRateLimits } from "@/lib/rate-limit/index";
import {
  createWhatsAppIntake,
  createWhatsAppIntakeAndRunAgent,
  runIntakeAgent,
} from "@/server/agents/intake-agent";

// ---------- helpers to configure the select chain ----------

/**
 * Configure the select chain so that its terminal .limit() call resolves
 * with different results based on call order.
 *
 * selectResults[0] is returned on the first .limit() call,
 * selectResults[1] on the second, etc.
 */
function setupSelectResults(results: unknown[][]) {
  // Each call to db.select() returns a new chain with its own .limit() mock.
  // We configure db.select to return a fresh chain each invocation.
  let callIndex = 0;
  mockDbSelect.mockImplementation(() => {
    const resultRows = results[callIndex] ?? [];
    callIndex++;
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(resultRows),
    };
  });
}

/**
 * Configure db.insert so each invocation returns a chain whose
 * .values().returning() resolves with the provided rows.
 * insertConfigs is an array of { rows, rejectWith } indexed by call order.
 */
function setupInsertResults(
  insertConfigs: Array<{ rows?: unknown[]; rejectWith?: Error }>
) {
  let callIndex = 0;
  mockDbInsert.mockImplementation(() => {
    const cfg = insertConfigs[callIndex] ?? { rows: [] };
    callIndex++;
    const returningMock = cfg.rejectWith
      ? vi.fn().mockRejectedValue(cfg.rejectWith)
      : vi.fn().mockResolvedValue(cfg.rows ?? []);
    const valuesMock = vi.fn().mockReturnValue({
      returning: returningMock,
    });
    // Also make values() itself awaitable (no .returning() call).
    const valuesResult = { returning: returningMock };
    // When the code does: await db.insert(t).values({...})  (no .returning())
    // the chain needs to be a thenable. We add a then() so it resolves.
    (valuesResult as { then?: unknown }).then = (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(cfg.rows ?? []).then(resolve);
    valuesMock.mockReturnValue(valuesResult);
    return { values: valuesMock };
  });
}

// ---------- tests ----------
describe("runIntakeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("chooses WhatsApp extraction for whatsapp cases", async () => {
    setupSelectResults([
      [{ id: "case-001", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);

    const result = await runIntakeAgent({
      caseId: "case-001",
      tenantId: "tenant-001",
      source: "whatsapp",
    });

    expect(result.action).toBe("extract_whatsapp");
    expect(result.ok).toBe(true);
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-001", "tenant-001", null, {
      retoma: false,
    });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "intake.agent_decision",
        payload: expect.objectContaining({
          channel: "whatsapp",
          action: "extract_whatsapp",
        }),
      })
    );
  });

  it("chooses email extraction for email cases", async () => {
    setupSelectResults([
      [{ id: "case-002", tenant_id: "tenant-001", channel: "email", status: "recibido" }],
    ]);

    const result = await runIntakeAgent({
      caseId: "case-002",
      tenantId: "tenant-001",
      source: "gmail",
    });

    expect(result.action).toBe("extract_email");
    expect(result.ok).toBe(true);
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-002", "tenant-001", null, {
      retoma: false,
    });
  });

  it("chooses email extraction for web form cases", async () => {
    setupSelectResults([
      [{ id: "case-web-001", tenant_id: "tenant-001", channel: "web", status: "recibido" }],
    ]);

    const result = await runIntakeAgent({
      caseId: "case-web-001",
      tenantId: "tenant-001",
      source: "worker",
    });

    expect(result.action).toBe("extract_email");
    expect(result.ok).toBe(true);
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-web-001", "tenant-001", null, {
      retoma: false,
    });
  });

  it("chooses email extraction for email_sim cases", async () => {
    setupSelectResults([
      [{ id: "case-sim-001", tenant_id: "tenant-001", channel: "email_sim", status: "procesando" }],
    ]);

    const result = await runIntakeAgent({
      caseId: "case-sim-001",
      tenantId: "tenant-001",
      userId: "user-001",
      source: "simulate",
    });

    expect(result.action).toBe("extract_email");
    expect(result.ok).toBe(true);
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith(
      "case-sim-001",
      "tenant-001",
      "user-001",
      { retoma: false }
    );
  });

  it("retoma llega al worker", async () => {
    setupSelectResults([
      [{ id: "case-003", tenant_id: "tenant-001", channel: "email", status: "procesando" }],
    ]);

    await runIntakeAgent({
      caseId: "case-003",
      tenantId: "tenant-001",
      source: "worker",
      retoma: true,
    });

    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-003", "tenant-001", null, {
      retoma: true,
    });
  });

  it("hasta, cuando mata Vercel la invocación, llega al worker", async () => {
    setupSelectResults([
      [{ id: "case-004", tenant_id: "tenant-001", channel: "whatsapp", status: "procesando" }],
    ]);

    await runIntakeAgent({
      caseId: "case-004",
      tenantId: "tenant-001",
      source: "whatsapp",
      hasta: 1_800_000_000_000,
    });

    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-004", "tenant-001", null, {
      retoma: false,
      hasta: 1_800_000_000_000,
    });
  });

  it("returns case_not_found when db returns no rows", async () => {
    setupSelectResults([[]]);

    const result = await runIntakeAgent({
      caseId: "missing-case",
      tenantId: "tenant-001",
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe("case_not_found");
    expect(mockRunEmailExtractionWorker).not.toHaveBeenCalled();
  });

  it("returns case_not_found when db throws", async () => {
    mockDbSelect.mockImplementation(() => {
      throw new Error("db error");
    });

    const result = await runIntakeAgent({
      caseId: "case-err",
      tenantId: "tenant-001",
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe("case_not_found");
  });
});

describe("createWhatsAppIntakeAndRunAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("stores a new WhatsApp case and message, then runs the intake agent", async () => {
    // select calls in order:
    //   1. findExistingWhatsAppCase → [] (no existing case)
    //   2. runIntakeAgent (case lookup) → the newly created case row
    setupSelectResults([
      [], // findExistingWhatsAppCase returns nothing
      [{ id: "case-whatsapp-001", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);

    // insert calls in order:
    //   1. createWhatsAppCase (cases insert .returning({id})) → [{id}]
    //   2. insertWhatsAppMessage — claimMessages insert (no .returning())
    //   3. insertWhatsAppMessage — rawMessages insert (no .returning())
    setupInsertResults([
      { rows: [{ id: "case-whatsapp-001" }] }, // cases insert
      { rows: [] },                              // claimMessages insert
      { rows: [] },                              // rawMessages insert
    ]);

    const result = await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "Tuve un choque el 27/07/2025. Siniestro 91500000-2.",
      providerMessageId: "wamid-001",
    });

    expect(result.caseId).toBe("case-whatsapp-001");
    expect(result.created).toBe(true);
    // Un caso recién abierto lo contesta el agente.
    expect(mockMarcarParaResponder).not.toHaveBeenCalled();
    expect(result.agent.action).toBe("extract_whatsapp");
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith(
      "case-whatsapp-001",
      "tenant-001",
      null,
      { retoma: false }
    );

    // Verify inserts were made (cases, claimMessages, rawMessages).
    expect(mockDbInsert).toHaveBeenCalledTimes(3);

    // Verify the claimMessages insert had the right payload.
    const claimMsgValuesCall = mockDbInsert.mock.results[1].value.values.mock.calls[0][0];
    expect(claimMsgValuesCall).toMatchObject({
      provider: "whatsapp",
      from_addr: "+5491112345678",
      body_text: expect.stringContaining("choque"),
    });

    // Verify the rawMessages insert had the right payload.
    const rawMsgValuesCall = mockDbInsert.mock.results[2].value.values.mock.calls[0][0];
    expect(rawMsgValuesCall).toMatchObject({
      channel: "whatsapp",
      body: expect.stringContaining("Siniestro"),
    });
  });

  it("reuses an existing WhatsApp case thread instead of creating a new one", async () => {
    // select calls in order:
    //   1. findExistingWhatsAppCase → existing case id
    //   2. runIntakeAgent case lookup → case row
    setupSelectResults([
      [{ id: "case-existing-001", status: "info_faltante" }],
      [{ id: "case-existing-001", tenant_id: "tenant-001", channel: "whatsapp", status: "info_faltante" }],
    ]);

    // Only 2 inserts: claimMessages + rawMessages (no cases insert since case exists)
    setupInsertResults([
      { rows: [] }, // claimMessages
      { rows: [] }, // rawMessages
    ]);

    const result = await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "Follow-up message.",
    });

    expect(result.caseId).toBe("case-existing-001");
    expect(result.created).toBe(false);
    // La conversación sigue con el agente: ni la marca ni su UPDATE.
    expect(mockMarcarParaResponder).not.toHaveBeenCalled();
    expect(result.agent.action).toBe("extract_whatsapp");
    // cases insert should NOT have been called.
    expect(mockDbInsert).toHaveBeenCalledTimes(2);
  });

  // En `procesando` el worker que corre puede cerrar el caso sin leer el
  // mensaje nuevo, y ahí nadie lo contesta.
  it("no busca el caso entre los que el agente está procesando", async () => {
    setupSelectResults([[], []]);
    setupInsertResults([{ rows: [{ id: "case-nuevo" }] }, { rows: [] }, { rows: [] }]);

    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "Hola",
    });

    const busqueda = mockDbSelect.mock.results[0].value.where.mock.calls[0][0];
    const { params } = new PgDialect().sqlToQuery(busqueda);
    expect(params).toEqual(expect.arrayContaining(["info_faltante", "listo"]));
    expect(params).not.toContain("procesando");
  });

  it("si el agente ya terminó, lo marca el ingreso antes del worker", async () => {
    setupSelectResults([
      [{ id: "case-listo-001", status: "listo" }],
      [{ id: "case-listo-001", tenant_id: "tenant-001", channel: "whatsapp", status: "listo" }],
    ]);
    setupInsertResults([{ rows: [] }, { rows: [] }]);

    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "¿Y ahora qué hago?",
      providerMessageId: "wamid-nuevo",
    });

    // Si el `after()` del webhook no llega a correr, el mensaje no queda sin marcar.
    expect(mockMarcarParaResponder).toHaveBeenCalledWith("case-listo-001", "tenant-001", undefined);
    expect(mockMarcarParaResponder.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunEmailExtractionWorker.mock.invocationCallOrder[0]
    );
  });

  // Meta reentrega el mensaje que cerró el caso: marcarlo sin condición dejaba
  // en «Para responder» un caso que el agente ya había contestado.
  it("una reentrega marca sólo si queda un mensaje sin contestar", async () => {
    setupSelectResults([
      [{ id: "case-listo-001", status: "listo" }],
      [{ id: "case-listo-001", tenant_id: "tenant-001", channel: "whatsapp", status: "listo" }],
    ]);
    setupInsertResults([{ rejectWith: Object.assign(new Error("dup"), { code: "23505" }) }]);

    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "Listo, gracias",
      providerMessageId: "wamid-repetido",
    });

    expect(mockMarcarParaResponder).toHaveBeenCalledWith("case-listo-001", "tenant-001", "sinContestar");
  });

  it("si marcar falla, el ingreso tira para que Meta reintente", async () => {
    setupSelectResults([[{ id: "case-listo-001", status: "listo" }]]);
    setupInsertResults([{ rows: [] }, { rows: [] }]);
    mockMarcarParaResponder.mockRejectedValueOnce(new Error("neon"));

    await expect(
      createWhatsAppIntakeAndRunAgent({
        tenantId: "tenant-001",
        from: "+5491112345678",
        body: "Hola",
        providerMessageId: "wamid-x",
      })
    ).rejects.toThrow("neon");
    expect(mockRunEmailExtractionWorker).not.toHaveBeenCalled();
  });
});

describe("createWhatsAppIntake — simulated numbers never reach WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  /** The row handed to the first cases insert. */
  function insertedCase(): Record<string, unknown> | undefined {
    const chain = mockDbInsert.mock.results[0]?.value as
      | { values: ReturnType<typeof vi.fn> }
      | undefined;
    return chain?.values.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  }

  it("marks a simulated intake as whatsapp_sim", async () => {
    // The simulation and BSP paths invent their phone numbers. They used to be
    // safe only because the route never asked for a reply; the orchestrator
    // answers every case now, so the case itself has to carry the warning.
    setupSelectResults([
      [],
      [{ id: "case-sim-1", tenant_id: "tenant-001", channel: "whatsapp_sim", status: "recibido" }],
    ]);
    setupInsertResults([{ rows: [{ id: "case-sim-1" }] }, { rows: [] }, { rows: [] }]);

    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "5491100000000",
      body: "Choque simulado",
      simulated: true,
    });

    expect(insertedCase()?.channel).toBe("whatsapp_sim");
    // El historial tenía "whatsapp" fijo acá, así que un caso simulado quedaba
    // anotado como si hubiera llegado por el canal real.
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ channel: "whatsapp_sim" }),
      })
    );
  });

  it("leaves a real intake on the whatsapp channel", async () => {
    setupSelectResults([
      [],
      [{ id: "case-real-1", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);
    setupInsertResults([{ rows: [{ id: "case-real-1" }] }, { rows: [] }, { rows: [] }]);

    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "5491100000000",
      body: "Choqué en Bahía Blanca",
    });

    expect(insertedCase()?.channel).toBe("whatsapp");
  });
});

/**
 * El nombre de perfil, guardado en el INSERT que ya ocurre.
 *
 * Meta lo manda en cada webhook, `parseCloudApiMessages` ya lo leia y moria en
 * `ingest`. Va a `raw_payload` y NUNCA a `from_addr`: ahi es el `to` del
 * mensajero, la clave de hilo, la entrada del freno del numero reservado —que
 * saca los no-digitos— y la del telefono de contacto.
 */
describe("createWhatsAppIntake — el nombre de perfil", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
    setupSelectResults([
      [],
      [{ id: "case-n-1", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);
    setupInsertResults([{ rows: [{ id: "case-n-1" }] }, { rows: [] }, { rows: [] }]);
  });

  /** La fila que se le pasa al insert de claim_messages. */
  function mensaje(): Record<string, unknown> {
    const chain = mockDbInsert.mock.results[1].value as { values: ReturnType<typeof vi.fn> };
    return chain.values.mock.calls[0][0] as Record<string, unknown>;
  }

  it("viaja en raw_payload y no en from_addr", async () => {
    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "5491100000000",
      body: "Choque en Alem",
      senderName: "Martin Sosa",
    });

    expect(mensaje().raw_payload).toEqual({ profile_name: "Martin Sosa" });
    expect(mensaje().from_addr).toBe("5491100000000");
  });

  it("sin nombre, raw_payload queda como estaba", async () => {
    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "5491100000000",
      body: "Choque en Alem",
    });

    expect(mensaje().raw_payload).toEqual({});
  });
});

/**
 * Más de 20 mensajes en 10 minutos del mismo número (E12): del 21° en adelante
 * el mensaje se guarda sin correr el agente, y el caso pasa a «Para
 * responder» aunque la conversación siga abierta.
 *
 * Ventana fija de Postgres, no deslizante: una ráfaga a caballo de dos
 * ventanas puede pasar hasta 40 mensajes. Aceptado por el dueño; no se prueba
 * acá porque el limitador en memoria del test no mueve el reloj.
 */
describe("tope por remitente (E12)", () => {
  const CRED = { accessToken: "test-token", phoneNumberId: "123456", wabaId: "654321", autoalta: false, vencida: false };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCredenciales.mockResolvedValue(CRED);
    mockWriteAuditLog.mockResolvedValue(undefined);
    mockMarcarAunqueSiga.mockResolvedValue(undefined);
    clearAllRateLimits();
  });

  /**
   * Arma los selects e inserts de `n` mensajes seguidos del mismo remitente.
   * `dupEn` son los índices (0-based) que llegan como reentrega (código 23505):
   * no crean fila nueva y no cuentan para el tope.
   */
  function armarTanda(n: number, dupEn: Set<number> = new Set()) {
    const selects: unknown[][] = [];
    const inserts: Array<{ rows?: unknown[]; rejectWith?: Error }> = [];
    for (let i = 0; i < n; i++) {
      selects.push(i === 0 ? [] : [{ id: "case-remitente", status: "recibido" }]);
      if (i === 0) inserts.push({ rows: [{ id: "case-remitente" }] }); // cases insert
      if (dupEn.has(i)) {
        inserts.push({ rejectWith: Object.assign(new Error("dup"), { code: "23505" }) });
      } else {
        inserts.push({ rows: [{ id: `msg-${i}` }] }); // claimMessages
        inserts.push({ rows: [] }); // rawMessages
      }
    }
    setupSelectResults(selects);
    setupInsertResults(inserts);
  }

  it("las primeras 20 pasan, sin marcar", async () => {
    armarTanda(20);

    for (let i = 0; i < 20; i++) {
      const r = await createWhatsAppIntake({
        tenantId: "tenant-001",
        from: "5490000000021",
        body: `mensaje ${i}`,
      });
      expect(r.excedente).toBe(false);
    }
    expect(mockMarcarAunqueSiga).not.toHaveBeenCalled();
  });

  it("el 21° pasa el tope: se guarda, no se lee, y marca aunque el agente siga", async () => {
    armarTanda(21);

    let ultimo;
    for (let i = 0; i < 21; i++) {
      ultimo = await createWhatsAppIntake({
        tenantId: "tenant-001",
        from: "5490000000021",
        body: `mensaje ${i}`,
      });
    }

    expect(ultimo?.excedente).toBe(true);
    expect(mockMarcarAunqueSiga).toHaveBeenCalledWith("case-remitente", "tenant-001");
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.message_not_read",
        payload: expect.objectContaining({ motivo: "tope_por_remitente" }),
      })
    );
    // El EMAIL_RECEIVED sigue: el mensaje entró y quedó guardado.
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "email.received" })
    );
  });

  it("un remitente distinto en la misma ventana no comparte cupo", async () => {
    armarTanda(21);
    let ultimoA;
    for (let i = 0; i < 21; i++) {
      ultimoA = await createWhatsAppIntake({
        tenantId: "tenant-001",
        from: "5490000000021",
        body: `mensaje ${i}`,
      });
    }
    expect(ultimoA?.excedente).toBe(true);

    // Otro número, mismo tenant, misma ventana: cupo propio, todavía entero.
    setupSelectResults([[]]);
    setupInsertResults([{ rows: [{ id: "case-otro" }] }, { rows: [] }, { rows: [] }]);
    const otro = await createWhatsAppIntake({
      tenantId: "tenant-001",
      from: "5490000000099",
      body: "otro remitente",
    });
    expect(otro.excedente).toBe(false);
  });

  it("una reentrega no suma para el tope", async () => {
    // 20 reales de verdad, con 5 reentregas de por medio que no cuentan.
    const dupEn = new Set([4, 9, 14, 19, 24]);
    armarTanda(26, dupEn);

    let ultimo;
    for (let i = 0; i < 26; i++) {
      ultimo = await createWhatsAppIntake({
        tenantId: "tenant-001",
        from: "5490000000021",
        body: `mensaje ${i}`,
      });
      if (dupEn.has(i)) expect(ultimo.excedente).toBe(false);
    }

    // El intento real número 21 (el 26° de la tanda) es el que pasa el tope.
    expect(ultimo?.excedente).toBe(true);
  });

  it("simulado y real del mismo número no comparten cupo", async () => {
    armarTanda(21);
    let ultimoSim;
    for (let i = 0; i < 21; i++) {
      ultimoSim = await createWhatsAppIntake({
        tenantId: "tenant-001",
        from: "5490000000021",
        body: `mensaje ${i}`,
        simulated: true,
      });
    }
    expect(ultimoSim?.excedente).toBe(true);

    // El mismo número, sin simular: cupo propio, porque el canal entra en el hash.
    setupSelectResults([[]]);
    setupInsertResults([{ rows: [{ id: "case-real" }] }, { rows: [] }, { rows: [] }]);
    const real = await createWhatsAppIntake({
      tenantId: "tenant-001",
      from: "5490000000021",
      body: "sin simular",
    });
    expect(real.excedente).toBe(false);
  });

  it("pasado el tope, los adjuntos no se bajan ni se guardan", async () => {
    armarTanda(21);
    mockDownloadMedia.mockResolvedValue({ data: Buffer.from("jpg"), mimeType: "image/jpeg" });
    mockRehost.mockResolvedValue([]);

    for (let i = 0; i < 20; i++) {
      await createWhatsAppIntake({
        tenantId: "tenant-001",
        from: "5490000000021",
        body: `mensaje ${i}`,
      });
    }
    const r = await createWhatsAppIntake({
      tenantId: "tenant-001",
      from: "5490000000021",
      body: "mensaje 20",
      media: [{ id: "m21", mimeType: "image/jpeg", filename: "foto.jpg" }],
    });

    expect(r.excedente).toBe(true);
    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(mockRehost).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.message_not_read",
        payload: expect.objectContaining({ motivo: "tope_por_remitente", adjuntos_omitidos: 1 }),
      })
    );
  });

  it("en el último mensaje bajo el tope los adjuntos sí se bajan", async () => {
    armarTanda(20);
    mockDownloadMedia.mockResolvedValue({ data: Buffer.from("jpg"), mimeType: "image/jpeg" });
    mockRehost.mockResolvedValue([]);

    let ultimo;
    for (let i = 0; i < 20; i++) {
      ultimo = await createWhatsAppIntake({
        tenantId: "tenant-001",
        from: "5490000000021",
        body: `mensaje ${i}`,
        media: i === 19 ? [{ id: "m20", mimeType: "image/jpeg", filename: "foto.jpg" }] : undefined,
      });
    }

    expect(ultimo?.excedente).toBe(false);
    expect(mockDownloadMedia).toHaveBeenCalledTimes(1);
    expect(mockDownloadMedia).toHaveBeenCalledWith("m20", CRED);
    expect(mockCredenciales).toHaveBeenCalledWith("tenant-001");
    expect(mockRehost).toHaveBeenCalledTimes(1);
  });

  it("sin número conectado no se baja nada: el adjunto queda como «no se pudo bajar»", async () => {
    armarTanda(1);
    mockCredenciales.mockResolvedValue(null);
    mockRehost.mockResolvedValue([]);

    await createWhatsAppIntake({
      tenantId: "tenant-001",
      from: "5490000000021",
      body: "mi foto",
      media: [{ id: "m1", mimeType: "image/jpeg", filename: "foto.jpg" }],
    });

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    const { attachments } = mockRehost.mock.calls[0]![0] as { attachments: Array<Record<string, unknown>> };
    expect(attachments[0]).toMatchObject({ Name: "foto.jpg", rechazoPrevio: "download_failed" });
  });
});
