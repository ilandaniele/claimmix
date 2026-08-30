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
  { id: "ef-1", case_id: "case-uuid-1", field_key: "date", field_value: "2024-01-15", confidence: 0.95 },
  { id: "ef-2", case_id: "case-uuid-1", field_key: "location", field_value: "Av. Corrientes 1234", confidence: 0.88 },
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
  },
  {
    id: 2,
    event_type: "case.closed",
    created_at: "2024-01-16T12:00:00Z",
    reason: null,
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
