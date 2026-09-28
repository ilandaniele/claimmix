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
import {
  buildCaseFilters,
  consultaListado,
  consultaPorEstado,
  desdeDePeriodo,
  listCases,
  listCasesForExport,
} from "@/server/cases/list";
import { db } from "@/lib/db";
import { enTenant, enTenantVarias } from "@/data/scope";
import { puenteDeAlcance } from "../mocks/puente-de-alcance";

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

// ── listCases ─────────────────────────────────────────────────────────────────

/**
 * Desde que `listCases` pasa por la capa de datos, estos tests no necesitan
 * imitar la cadena de drizzle: alcanza con decir qué devuelve la capa.
 *
 * Es la diferencia entre probar el comportamiento y probar la forma en que se
 * arma una consulta. `listCasesForExport`, más abajo, arma su propia cadena
 * porque ahí lo que se prueba es la consulta misma, y también está cubierto
 * en `tests/unit/coverage-gap-fill.test.ts`.
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
    vi.mocked(enTenant).mockImplementation(puenteDeAlcance(() => db).enTenant as never);
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
    ["fraude", { fraude: "high" }],
    ["channel", { channel: "email" }],
    ["is_claim", { is_claim: true }],
    ["customer_id", { customer_id: "c-1" }],
    ["policy_id", { policy_id: "p-1" }],
    ["para_responder", { para_responder: true }],
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

    const result = await listCasesForExport(TENANT_ID, { status: ["cerrado"] });
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

describe("buildCaseFilters — «Para responder»", () => {
  it("pide para_responder_desde no nulo, y nada por inquilino", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ para_responder: true });

    expect(where).toBeDefined();
    const compilado = new PgDialect().sqlToQuery(where!).sql;
    expect(compilado).toContain('"para_responder_desde" is not null');
    expect(compilado).not.toContain("tenant_id");
  });

  it("sin el parámetro no filtra", () => {
    expect(buildCaseFilters({})).toBeUndefined();
  });
});

describe("consultaListado — orden de «Para responder»", () => {
  // Un cliente de drizzle que no se conecta: sólo arma el SQL.
  async function ordenDe(query: Partial<typeof baseQuery> & { para_responder?: true; cola?: "mia" }) {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    return consultaListado(datos as never, { ...baseQuery, ...query }, "yo-1")
      .toSQL()
      .sql.split(" order by ")[1];
  }

  it("primero el que espera respuesta hace más tiempo", async () => {
    expect(await ordenDe({ para_responder: true })).toMatch(/^"cases"\."para_responder_desde" asc /);
  });

  it("sin la sección ordena por la columna pedida", async () => {
    expect(await ordenDe({})).toMatch(/^"cases"\."created_at" desc /);
  });

  it("«Mi cola» ordena por lo más viejo primero", async () => {
    expect(await ordenDe({ cola: "mia" })).toMatch(/^"cases"\."updated_at" asc /);
  });

  it("selecciona el nombre del analista asignado", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    const sql = consultaListado(datos as never, baseQuery).toSQL().sql;
    expect(sql).toContain("select u.full_name from users u");
  });
});

describe("buildCaseFilters — q", () => {
  it("busca por nombre/póliza con ilike y por el nombre extraído con EXISTS", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ q: "juan" });

    expect(where).toBeDefined();
    const { sql: compilado, params } = new PgDialect().sqlToQuery(where!);
    expect(compilado).toContain("ilike");
    expect(compilado).toContain("exists");
    expect(compilado).toContain("field_key");
    expect(params).toContain("%juan%");
  });

  it("un texto con forma de número de caso compara por los últimos 8 hex del id", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ q: "SIN-1234-abcd" });

    expect(where).toBeDefined();
    const { sql: compilado, params } = new PgDialect().sqlToQuery(where!);
    expect(compilado).toContain("replace(");
    expect(params).toContain("1234abcd");
  });

  it("sin forma de número de caso no agrega la comparación por id", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ q: "Juan Pérez" });

    expect(where).toBeDefined();
    const { sql: compilado } = new PgDialect().sqlToQuery(where!);
    expect(compilado).not.toContain("replace(");
  });
});

describe("buildCaseFilters — fraude (G35)", () => {
  it("fraude agrega inArray sobre fraud_risk_level", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ fraude: ["high"] });

    expect(where).toBeDefined();
    const { sql: compilado, params } = new PgDialect().sqlToQuery(where!);
    expect(compilado).toContain('"fraud_risk_level"');
    expect(params).toContain("high");
  });

  it("sin fraude las condiciones son idénticas a las de antes", () => {
    expect(buildCaseFilters({})).toEqual(buildCaseFilters({ fraude: undefined }));
    expect(buildCaseFilters({})).toBeUndefined();
  });
});

describe("buildCaseFilters — período", () => {
  it("desde agrega un piso de fecha sobre created_at", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ desde: "2026-09-20T03:00:00.000Z" });

    expect(where).toBeDefined();
    const { sql: compilado, params } = new PgDialect().sqlToQuery(where!);
    expect(compilado).toContain('"created_at" >=');
    expect(params).toContain("2026-09-20T03:00:00.000Z");
  });

  it("sin período no filtra", () => {
    expect(buildCaseFilters({})).toBeUndefined();
  });
});

describe("desdeDePeriodo", () => {
  const cuando = new Date("2026-09-26T12:00:00.000Z"); // 09:00 en Argentina, mismo día

  it("sin período es todo el tiempo", () => {
    expect(desdeDePeriodo(undefined, cuando)).toBeUndefined();
  });

  it.each([
    ["hoy", 1],
    ["7d", 7],
    ["30d", 30],
    ["90d", 90],
  ] as const)("%s es la medianoche argentina de hace %d días, hoy incluido", (periodo, dias) => {
    const esperado = new Date(Date.UTC(2026, 8, 26 - (dias - 1), 3, 0, 0, 0)).toISOString();
    expect(desdeDePeriodo(periodo, cuando)).toBe(esperado);
  });
});

describe("consultaPorEstado", () => {
  it("sin where cuenta todos los estados, sin condición", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    const sql = consultaPorEstado(datos as never).toSQL().sql;
    expect(sql).not.toContain("where");
    expect(sql).toContain("group by");
  });

  it("con where limita el conteo a la búsqueda/período de la bandeja", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    const where = buildCaseFilters({ q: "juan" });
    const sql = consultaPorEstado(datos as never, where).toSQL().sql;
    expect(sql).toContain("where");
    expect(sql).toContain("ilike");
  });
});

describe("buildCaseFilters — «Mi cola»", () => {
  it("con yo: referencia assigned_to y la ventana de 48 horas", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ cola: "mia" }, "yo-1");

    expect(where).toBeDefined();
    const compilado = new PgDialect().sqlToQuery(where!).sql;
    expect(compilado).toContain("assigned_to");
    expect(compilado).toContain("48 hours");
    expect(compilado).not.toContain("tenant_id");
  });

  it("sin yo cierra en falso", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters({ cola: "mia" });

    expect(where).toBeDefined();
    const compilado = new PgDialect().sqlToQuery(where!).sql;
    expect(compilado).toContain("false");
  });
});
