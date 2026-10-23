/**
 * Unit tests for the case detail query builder.
 *
 * Uses a mocked Drizzle db to test IDOR handling and response structure.
 */

// vi.mock must be hoisted before any imports that trigger @/lib/db
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
vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  },
  tables: {},
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { getCaseDetail } from "@/server/cases/get";
import { db } from "@/lib/db";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";

const mockCase = {
  id: "case-uuid-1",
  tenant_id: TENANT_ID,
  status: "listo",
  claim_type: "choque",
};

const mockExtractedFields = [
  { id: "ef-1", case_id: "case-uuid-1", field_key: "date", field_value: "2024-01-15", confidence: 0.95, source: "ai" as const },
  { id: "ef-2", case_id: "case-uuid-1", field_key: "location", field_value: "Av. Corrientes 1234", confidence: 0.88, source: "ai" as const },
];

const mockMissingDocs = [
  { id: "md-1", case_id: "case-uuid-1", doc_key: "foto_oblea_vtv" },
];

/*
 * Las filas traen `ip`, `ua` y un payload completo a propósito: es lo que la
 * base guarda de verdad, y lo que se comprueba abajo es que NADA de eso salga
 * hacia el navegador.
 */
const mockAuditEntries = [
  {
    id: 1,
    event_type: "case.status_changed",
    created_at: "2024-01-15T10:00:00Z",
    payload: { reason: "field_confirmation", from: "recibido", to: "listo" },
    ip: "203.0.113.7",
    ua: "Chrome/140",
    actor_id: "user-001",
    tenant_id: TENANT_ID,
  },
  {
    id: 2,
    event_type: "case.closed",
    created_at: "2024-01-16T12:00:00Z",
    payload: {},
    ip: "203.0.113.9",
    ua: "Firefox/141",
    actor_id: "user-002",
    tenant_id: TENANT_ID,
  },
];

/** Lo que la pantalla necesita, que es lo único que tiene que salir. */
const AUDITORIA_ESPERADA = [
  {
    id: 1,
    event_type: "case.status_changed",
    created_at: "2024-01-15T10:00:00Z",
    reason: "field_confirmation",
    actor_name: null,
    con_actor: true,
  },
  {
    id: 2,
    event_type: "case.closed",
    created_at: "2024-01-16T12:00:00Z",
    reason: null,
    actor_name: null,
    con_actor: true,
  },
];

// ── Helper: configure db.select mock chain ────────────────────────────────────

/**
 * Sets up the db.select mock to return:
 * - caseRows on the first call  (cases query:          .from().where().limit() )
 * - extractedRows on 2nd call   (extracted_fields:     .from().where().orderBy().catch() )
 * - missingRows on 3rd call     (missing_docs:         .from().where().orderBy().catch() )
 * - auditRows on 4th call       (audit_log:            .from().where().orderBy().limit().catch() )
 *
 * IMPORTANT: intermediate chain steps (from, where, orderBy) must NOT be
 * thenable — making them thenable causes `await chain` to resolve before
 * .limit() is called. Only the terminal step resolves.
 *
 * The parallel queries use .catch(() => []) — so the chain must be a real
 * Promise-like value at the point where .catch() is called.
 * Chain: db.select().from().where().orderBy() returns a Promise (resolved via
 * mockResolvedValue on the last chained call).
 */
function setupSelectMock(opts: {
  caseRows: unknown[];
  extractedRows: unknown[];
  missingRows: unknown[];
  auditRows: unknown[];
}) {
  const { caseRows, extractedRows, missingRows, auditRows } = opts;

  /**
   * Build a non-thenable chain where:
   * - .from() / .where() return the chain (not a Promise)
   * - .limit() resolves to rows (cases query uses .limit())
   * - .orderBy() returns an object that is a Promise AND has .limit()
   *   (extracted_fields/missing_docs await .orderBy(); audit_log calls .limit() on it)
   */
  const makeChain = (resolveValue: unknown[]): any => {
    // afterOrderBy: a Promise that also has .limit()
    const afterOrderBy: Promise<unknown[]> & { limit: () => Promise<unknown[]> } = Object.assign(
      Promise.resolve(resolveValue),
      { limit: vi.fn().mockResolvedValue(resolveValue) }
    );

    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnValue(afterOrderBy),
      limit: vi.fn().mockResolvedValue(resolveValue),
    };
    return chain;
  };

  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    const call = callCount;

    if (call === 1) return makeChain(caseRows);
    if (call === 2) return makeChain(extractedRows);
    if (call === 3) return makeChain(missingRows);
    return makeChain(auditRows);
  });
}

/**
 * Igual que `setupSelectMock`, pero una de las consultas relacionadas revienta.
 *
 * `cual` es el número de llamada a `db.select()`: 2 = campos extraídos,
 * 3 = documentación faltante, 4 = historial.
 */
function setupSelectMockConFalla(cual: 2 | 3 | 4, opts: {
  caseRows: unknown[];
  extractedRows: unknown[];
  missingRows: unknown[];
  auditRows: unknown[];
}) {
  const { caseRows, extractedRows, missingRows, auditRows } = opts;

  const cadenaQueRevienta = (): any => {
    const rechazo = Object.assign(Promise.reject(new Error("se cayó la base")), {
      limit: vi.fn().mockRejectedValue(new Error("se cayó la base")),
    });
    // Se consume el rechazo para que node no lo reporte como no manejado: el
    // código bajo prueba le pone su propio `.catch`, que es lo que se verifica.
    void (rechazo as Promise<unknown>).catch(() => {});
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnValue(rechazo),
      limit: vi.fn().mockRejectedValue(new Error("se cayó la base")),
    };
  };

  const cadenaNormal = (filas: unknown[]): any => {
    const despues = Object.assign(Promise.resolve(filas), {
      limit: vi.fn().mockResolvedValue(filas),
    });
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnValue(despues),
      limit: vi.fn().mockResolvedValue(filas),
    };
  };

  let n = 0;
  vi.mocked(db.select).mockImplementation(() => {
    n++;
    if (n === cual) return cadenaQueRevienta();
    if (n === 1) return cadenaNormal(caseRows);
    if (n === 2) return cadenaNormal(extractedRows);
    if (n === 3) return cadenaNormal(missingRows);
    return cadenaNormal(auditRows);
  });
}

/**
 * Cada consulta relacionada degrada por su cuenta.
 *
 * Esto NO estaba probado, y es la razón por la que las consultas de esta
 * pantalla no se pueden juntar en un solo `enTenantVarias`: un lote es UNA
 * transacción, y un hipo leyendo el historial de auditoría se llevaría puestos
 * también los campos extraídos y la documentación faltante.
 *
 * Mientras estos tests estén en verde, esa propiedad se sostiene. Si alguien
 * junta las consultas, se ponen rojos y explican por qué.
 */
/**
 * Al navegador va lo que la pantalla muestra, y nada más.
 *
 * La consulta era un `select()` pelado, así que la línea de tiempo del caso
 * recibía también `ip` y `ua` —de qué computadora y con qué navegador trabajó
 * cada analista— y el payload completo de cada evento, con claves de campo y
 * valores viejos y nuevos.
 *
 * Se volvió concreto el día que las confirmaciones de campo empezaron a guardar
 * la IP del analista: hasta entonces la columna venía casi siempre en null y el
 * exceso no se notaba.
 */
describe("getCaseDetail — el historial no lleva de más", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no manda la IP ni el navegador de quien hizo cada cosa", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: mockAuditEntries,
    });

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");
    const serializado = JSON.stringify(res!.audit_log);

    expect(serializado).not.toContain("203.0.113.7");
    expect(serializado).not.toContain("Chrome/140");
    expect(serializado).not.toContain("user-001");
  });

  it("del payload sale sólo el motivo, que es lo que se pinta", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: mockAuditEntries,
    });

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");

    expect(res!.audit_log[0].reason).toBe("field_confirmation");
    // El resto del payload no viaja: `from` y `to` no los muestra nadie.
    expect(JSON.stringify(res!.audit_log)).not.toContain("recibido");
  });

  it("quién lo hizo sale como nombre y como «hubo una persona», nunca como id", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: [
        { ...mockAuditEntries[0], actor_name: "Lucía Ramallo" },
        // El agente: sin persona detrás.
        { ...mockAuditEntries[1], actor_id: null, actor_name: null },
      ],
    });

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");

    expect(res!.audit_log[0]).toMatchObject({ actor_name: "Lucía Ramallo", con_actor: true });
    expect(res!.audit_log[1]).toMatchObject({ actor_name: null, con_actor: false });
    expect(JSON.stringify(res!.audit_log)).not.toContain("user-001");
  });

  it("lo que escribe el sistema no se firma con quien lo disparó", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: [
        // El worker graba el actor de quien tocó Re-analizar en sus eventos automáticos.
        { ...mockAuditEntries[0], event_type: "ai.extraction_complete", actor_name: "Lucía Ramallo" },
        { ...mockAuditEntries[1], event_type: "ai.extracted", actor_name: "Lucía Ramallo" },
        { ...mockAuditEntries[0], id: 3, event_type: "case.re_analyze_triggered", actor_name: "Lucía Ramallo" },
        // Bajar el JSON lo hace una persona, aunque no sea una intervención.
        { ...mockAuditEntries[0], id: 4, event_type: "case.exported_to_core", actor_name: "Lucía Ramallo" },
      ],
    });

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");

    expect(res!.audit_log[0]).toMatchObject({ actor_name: null, con_actor: false });
    expect(res!.audit_log[1]).toMatchObject({ actor_name: null, con_actor: false });
    expect(res!.audit_log[2]).toMatchObject({ actor_name: "Lucía Ramallo", con_actor: true });
    expect(res!.audit_log[3]).toMatchObject({ actor_name: "Lucía Ramallo", con_actor: true });
  });

  it("el nombre sale de la misma consulta, por la PK de users", async () => {
    setupSelectMock({ caseRows: [mockCase], extractedRows: [], missingRows: [], auditRows: mockAuditEntries });
    const original = vi.mocked(db.select).getMockImplementation()!;
    const campos: any[] = [];
    vi.mocked(db.select).mockImplementation((...args: unknown[]) => {
      campos.push(args[0]);
      return (original as (...a: unknown[]) => unknown)(...args) as never;
    });

    await getCaseDetail(TENANT_ID, "case-uuid-1");

    // Cuatro `select` en total: el nombre no abre una quinta consulta.
    expect(campos).toHaveLength(4);
    const { sql } = new PgDialect().sqlToQuery(campos[3].actor_name as SQL);
    expect(sql).toContain("from users u where u.id = ");
  });

  it("un evento sin motivo llega con null, no con undefined", async () => {
    // Va a un `!= null` en el componente: un undefined funcionaría, pero el
    // tipo dice `string | null` y conviene que la forma sea la que dice.
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: mockAuditEntries,
    });

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(res!.audit_log[1].reason).toBeNull();
  });
});

describe("getCaseDetail — el historial no se llena con los cambios del agente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** El `where` de la consulta del historial (la cuarta), ya renderizado con el dialecto de verdad. */
  async function dondeDelHistorial() {
    setupSelectMock({ caseRows: [mockCase], extractedRows: [], missingRows: [], auditRows: mockAuditEntries });
    const original = vi.mocked(db.select).getMockImplementation()!;
    const cadenas: any[] = [];
    vi.mocked(db.select).mockImplementation((...args: unknown[]) => {
      const c = (original as (...a: unknown[]) => unknown)(...args);
      cadenas.push(c);
      return c as never;
    });

    await getCaseDetail(TENANT_ID, "case-uuid-1");

    const donde = cadenas[3].where.mock.calls[0][0] as SQL;
    return new PgDialect().sqlToQuery(donde);
  }

  it("deja afuera el cambio de estado que escribió el agente, y sólo ese", async () => {
    const { sql, params } = await dondeDelHistorial();

    expect(sql).toContain(`"audit_log"."event_type" <> $`);
    expect(params).toContain("case.status_changed");
    expect(sql).toContain(`"audit_log"."payload"->>'trigger' is distinct from 'agent'`);
  });

  it("un cambio de estado hecho por una persona (sin trigger) sigue entrando: no se compara con <>", async () => {
    const { sql } = await dondeDelHistorial();

    expect(sql).not.toMatch(/->>'trigger' <> /);
  });

  it("las exportaciones al sistema central entran todas: la consulta no las filtra", async () => {
    const { sql, params } = await dondeDelHistorial();

    expect(params).not.toContain("case.exported_to_core");
    expect(sql).not.toContain("max(");
  });
});

describe("getCaseDetail — las fallas no se contagian", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TODO_BIEN = {
    caseRows: [mockCase],
    extractedRows: mockExtractedFields,
    missingRows: mockMissingDocs,
    auditRows: mockAuditEntries,
  };

  it("si falla el historial, los campos extraídos siguen llegando", async () => {
    setupSelectMockConFalla(4, TODO_BIEN);

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");

    expect(res).not.toBeNull();
    expect(res!.audit_log).toEqual([]);
    // Y lo demás intacto: es lo que un solo lote se llevaría puesto.
    expect(res!.extracted_fields).toEqual(mockExtractedFields);
    expect(res!.missing_docs).toEqual(mockMissingDocs);
    expect(res!.case).toEqual(mockCase);
  });

  it("si fallan los campos extraídos, el resto sigue llegando", async () => {
    setupSelectMockConFalla(2, TODO_BIEN);

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");

    expect(res!.extracted_fields).toEqual([]);
    expect(res!.missing_docs).toEqual(mockMissingDocs);
    expect(res!.audit_log).toEqual(AUDITORIA_ESPERADA);
  });

  it("si falla la documentación faltante, el resto sigue llegando", async () => {
    setupSelectMockConFalla(3, TODO_BIEN);

    const res = await getCaseDetail(TENANT_ID, "case-uuid-1");

    expect(res!.missing_docs).toEqual([]);
    expect(res!.extracted_fields).toEqual(mockExtractedFields);
    expect(res!.audit_log).toEqual(AUDITORIA_ESPERADA);
  });

  it("una falla en una relacionada NO convierte el caso en 404", async () => {
    // El null está reservado para «no existe o no es tuyo». Devolverlo por un
    // error de lectura le mostraría al analista que el caso no existe.
    setupSelectMockConFalla(4, TODO_BIEN);

    await expect(getCaseDetail(TENANT_ID, "case-uuid-1")).resolves.not.toBeNull();
  });
});

// ── getCaseDetail ─────────────────────────────────────────────────────────────

describe("getCaseDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns CaseDetail for an existing case", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.case).toEqual(mockCase);
    expect(result!.extracted_fields).toEqual([]);
    expect(result!.missing_docs).toEqual([]);
    expect(result!.audit_log).toEqual([]);
  });

  it("returns null when case is not found (IDOR prevention)", async () => {
    setupSelectMock({
      caseRows: [],
      extractedRows: [],
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "non-existent-uuid");
    // IDOR: not found or wrong tenant → null, caller returns 404 (never 403)
    expect(result).toBeNull();
  });

  it("returns null when the case belongs to a different tenant (wrong tenant filter returns no rows)", async () => {
    // Explicit tenant filter means wrong-tenant case returns zero rows
    setupSelectMock({
      caseRows: [],
      extractedRows: [],
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "another-tenant-case");
    expect(result).toBeNull();
  });

  it("returns null when the db.select throws (invalid uuid, etc.)", async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error("invalid input syntax for type uuid");
    });

    const result = await getCaseDetail(TENANT_ID, "not-a-uuid");
    expect(result).toBeNull();
  });

  it("includes extracted_fields when present", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: mockExtractedFields,
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.extracted_fields).toHaveLength(2);
    expect(result!.extracted_fields[0].field_key).toBe("date");
  });

  it("includes missing_docs when present", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: mockMissingDocs,
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.missing_docs).toHaveLength(1);
    expect(result!.missing_docs[0].doc_key).toBe("foto_oblea_vtv");
  });

  it("missing_docs sale sin repetidos y sin el dato que ya está presente", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [
        { id: "ef-3", case_id: "case-uuid-1", field_key: "accident_location", field_value: "Bahía Blanca", confidence: "0.80" },
      ],
      missingRows: [
        { id: "md-1", doc_key: "dni", satisfied_at: null, declined_at: null },
        { id: "md-2", doc_key: "dni_asegurado", satisfied_at: null, declined_at: null },
        { id: "md-3", doc_key: "accident_location", satisfied_at: null, declined_at: null },
        { id: "md-4", doc_key: "foto_oblea_vtv", satisfied_at: null, declined_at: null },
      ],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result!.missing_docs.map((d) => d.doc_key)).toEqual(["dni", "foto_oblea_vtv"]);
  });

  it("includes audit_log when present", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: mockAuditEntries,
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.audit_log).toHaveLength(2);
  });
});
