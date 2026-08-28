/**
 * Unit tests for the cases list query builder.
 *
 * Uses a mocked Drizzle db to test the query logic without a real DB.
 * Verifies filtering, pagination, and error handling behavior.
 */

// vi.mock must be hoisted before any imports that trigger @/lib/db
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

// La capa de datos: un solo mock reemplaza toda la imitación de la cadena de
// drizzle para `listCases`. La hidratación (`enTenant`) devuelve vacío por
// omisión, que es el caso normal —sólo se usa cuando falta el nombre o la póliza.
vi.mock("@/data/scope", () => ({
  enTenant: vi.fn().mockResolvedValue([]),
  enTenantVarias: vi.fn(),
}));

// countRows calls db.$count — mock the helper module so it delegates to our mocked db.$count
vi.mock("@/lib/db/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/helpers")>();
  return {
    ...actual,
    countRows: vi.fn(),
    firstRow: actual.firstRow,
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCases, listCasesForExport } from "@/server/cases/list";
import { db } from "@/lib/db";
import { countRows } from "@/lib/db/helpers";
import { enTenant, enTenantVarias } from "@/data/scope";

// ── Base query fixture ────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";

const baseQuery = {
  status: undefined,
  type: undefined,
  q: undefined,
  page: 1,
  per_page: 20,
  sort: "created_at" as const,
  order: "desc" as const,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a chainable mock for db.select() that resolves to `rows` at any
 * terminal step (.limit(), .offset(), or awaiting directly).
 */
function makeSelectChain(rows: unknown[]): any {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue(rows),
    // For listCasesForExport the terminal call is .limit() not .offset()
    // We override this below per test.
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
    catch: (onRejected: (e: unknown) => void) =>
      Promise.resolve(rows).catch(onRejected),
  };
  // Make .limit() also awaitable directly (needed for export path)
  chain.limit.mockImplementation(() => {
    const limitChain: any = {
      ...chain,
      offset: vi.fn().mockResolvedValue(rows),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(rows).then(resolve, reject),
      catch: (onRejected: (e: unknown) => void) =>
        Promise.resolve(rows).catch(onRejected),
    };
    return limitChain;
  });
  return chain;
}

// ── listCases ─────────────────────────────────────────────────────────────────

/**
 * Desde que `listCases` pasa por la capa de datos, estos tests no necesitan
 * imitar la cadena de drizzle: alcanza con decir qué devuelve la capa.
 *
 * Es la diferencia entre probar el comportamiento y probar la forma en que se
 * arma una consulta. `makeSelectChain` sigue existiendo más abajo sólo porque
 * `listCasesForExport` todavía no se migró.
 */
const CTX = { tenantId: TENANT_ID };

describe("listCases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns data and meta on success", async () => {
    const mockRows = [
      { id: "case-1", status: "listo", claim_type: "choque", policyholder_name: "Juan", policy_number: "POL-1" },
      { id: "case-2", status: "listo", claim_type: "robo", policyholder_name: "Ana", policy_number: "POL-2" },
    ];
    vi.mocked(enTenantVarias).mockResolvedValue([[{ n: 2 }], mockRows] as never);

    const result = await listCases(CTX, baseQuery);

    expect(result.data).toEqual(mockRows);
    expect(result.meta.total).toBe(2);
    expect(result.meta.page).toBe(1);
    expect(result.meta.per_page).toBe(20);
    expect(result.meta.pages).toBe(1);
  });

  it("le pasa a la capa el inquilino del contexto, y ningún otro", async () => {
    vi.mocked(enTenantVarias).mockResolvedValue([[{ n: 0 }], []] as never);

    await listCases(CTX, baseQuery);

    // Lo que se verifica no es que la consulta lleve un WHERE —ya no lo lleva—
    // sino que el contexto con el que se pide sea el de la sesión.
    expect(enTenantVarias).toHaveBeenCalledWith({ tenantId: TENANT_ID }, expect.any(Function));
  });

  it("calculates pages correctly", async () => {
    vi.mocked(enTenantVarias).mockResolvedValue([[{ n: 55 }], []] as never);

    const result = await listCases(CTX, { ...baseQuery, per_page: 20 });
    // 55 / 20 = 2.75 → ceil = 3
    expect(result.meta.pages).toBe(3);
  });

  it("returns empty data when count is 0", async () => {
    vi.mocked(enTenantVarias).mockResolvedValue([[{ n: 0 }], []] as never);

    const result = await listCases(CTX, baseQuery);
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.pages).toBe(0);
  });

  it("throws when the query fails", async () => {
    const err = new Error("relation does not exist");
    (err as any).code = "42P01";
    vi.mocked(enTenantVarias).mockRejectedValue(err);

    // El conteo y los datos viajan juntos, así que ya no hay dos errores
    // distintos que distinguir: hay uno, y lleva el código de Postgres.
    await expect(listCases(CTX, baseQuery)).rejects.toThrow("[listCases] query error: 42P01");
  });
});

// ── listCasesForExport ────────────────────────────────────────────────────────

describe("listCasesForExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Acá `enTenant` sí tiene que EJECUTAR el armador contra el db simulado.
    // El tapón de arriba —que devuelve vacío— existe para la hidratación de
    // `listCases`, donde lo normal es que no haya nada que hidratar; la
    // exportación, en cambio, es la consulta misma.
    vi.mocked(enTenant).mockImplementation(
      ((_ctx: unknown, armar: (d: unknown) => unknown) =>
        Promise.resolve(armar(db))) as never
    );
  });

  it("returns array of case rows", async () => {
    const mockRows = [{ id: "case-1" }, { id: "case-2" }];

    // Export chain: db.select().from().where().orderBy().limit() → resolves
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockRows),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    const result = await listCasesForExport(TENANT_ID, {});
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  /*
   * El export tiene que aplicar los MISMOS filtros que el listado.
   *
   * Se quedó con status/type/q y nunca recibió los cinco que se agregaron
   * después. Su propio contrato dice «acepta los mismos filtros que listCases»,
   * y no era cierto: filtrar la bandeja por críticos y tocar Exportar bajaba
   * mil filas de todas las severidades, sin ningún aviso.
   *
   * Se comprueba mirando el WHERE que se le pasa a la consulta y no el
   * resultado, porque el bug era justamente que el filtro nunca llegaba: un
   * test sobre las filas devueltas lo habría dejado pasar con un mock que
   * devuelve lo que sea.
   */
  /*
   * Uno por uno, y solo.
   *
   * La primera versión de este test pasaba los cinco filtros juntos y afirmaba
   * que el WHERE quedaba definido. Eso no probaba nada: sacando uno del código,
   * los otros cuatro seguían armando un WHERE y el test seguía verde. Lo agarré
   * corriéndolo contra el código roto a propósito.
   *
   * Con un filtro solo, si el código lo ignora no queda ninguna condición y el
   * WHERE es `undefined` — que es exactamente el bug que había.
   */
  it.each([
    ["severity", { severity: "critical" }],
    ["channel", { channel: "email" }],
    ["is_claim", { is_claim: true }],
    ["customer_id", { customer_id: "c-1" }],
    ["policy_id", { policy_id: "p-1" }],
  ])("aplica %s aunque sea el único filtro", async (_nombre, filtro) => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    await listCasesForExport(TENANT_ID, filtro as never);

    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.where.mock.calls[0][0]).toBeDefined();
  });

  it("sin filtros no arma WHERE, y no inventa uno por inquilino", async () => {
    // La otra mitad: si `where` recibiera siempre algo, el test de arriba
    // pasaría aunque el filtro no se aplicara. Y el filtro por inquilino lo
    // pone la base, no esta función.
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    await listCasesForExport(TENANT_ID, {} as never);

    expect(chain.where.mock.calls[0][0]).toBeUndefined();
  });

  it("returns empty array when no cases match", async () => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    const result = await listCasesForExport(TENANT_ID, { status: "cerrado" });
    expect(result).toEqual([]);
  });

  it("throws when the DB query errors", async () => {
    const dbErr = Object.assign(new Error("permission denied"), { code: "PGRST301" });
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(dbErr),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    await expect(listCasesForExport(TENANT_ID, {})).rejects.toThrow(
      "[listCasesForExport] error"
    );
  });
});
