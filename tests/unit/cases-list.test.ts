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
  consultaConteoPorEstado,
  consultaListado,
  consultaPorEstado,
  consultaTablero,
  desdeDePeriodo,
  listarTablero,
  listCases,
  listCasesForExport,
} from "@/server/cases/list";
import { TARJETAS_POR_COLUMNA } from "@/core/case/tablero";
import { ESTADOS_CERRADOS } from "@/core/case/fsm";
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
  async function consulta(query: Partial<typeof baseQuery> & { para_responder?: true; cola?: "mia"; is_claim?: boolean }) {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    return consultaListado(datos as never, { ...baseQuery, ...query }, "yo-1").toSQL();
  }
  async function ordenDe(query: Parameters<typeof consulta>[0]) {
    return (await consulta(query)).sql.split(" order by ")[1];
  }

  it("primero el que espera respuesta hace más tiempo, y a igual espera por id", async () => {
    expect(await ordenDe({ para_responder: true })).toMatch(
      /^"cases"\."para_responder_desde" asc, "cases"\."id" asc limit /
    );
  });

  it("sin la sección ordena por la columna pedida", async () => {
    expect(await ordenDe({})).toMatch(/^"cases"\."created_at" desc /);
  });

  it("«Mi cola» ordena primero lo vencido, después la gravedad, después lo más viejo y por último el id", async () => {
    const orden = await ordenDe({ cola: "mia" });
    const posiciones = [
      orden.indexOf('"cases"."vence_en" end <'),
      orden.indexOf('case "cases"."severity" when'),
      orden.indexOf('"cases"."updated_at" asc'),
      orden.indexOf('"cases"."id" asc'),
    ];
    expect(posiciones.every((p) => p >= 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
    expect(orden).toMatch(/\) desc nulls last, case "cases"\."severity"/);
    expect(orden).toMatch(/end desc nulls last, "cases"\."updated_at" asc, "cases"\."id" asc limit /);
  });

  it("lo vencido se mide contra el mismo instante que el conteo y sólo si el caso sigue abierto", async () => {
    const ahora = new Date("2026-10-07T12:00:00.000Z");
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    const { sql, params } = consultaListado(datos as never, { ...baseQuery, cola: "mia" }, "yo-1", ahora).toSQL();
    expect(params).toContain(ahora.toISOString());
    expect(sql.split(" order by ")[1]).toContain('case when "cases"."status" not in (');
  });

  it("el rango de gravedad ordena crítico antes que bajo", async () => {
    const { sql, params } = await consulta({ cola: "mia" });
    const cuando = sql.split(" order by ")[1].match(/when \$(\d+) then \$(\d+)::int/g) ?? [];
    expect(cuando).toHaveLength(4);
    const rango = (nivel: string) => {
      const i = params.indexOf(nivel);
      return Number(params[i + 1]);
    };
    expect(rango("critical")).toBeGreaterThan(rango("high"));
    expect(rango("high")).toBeGreaterThan(rango("medium"));
    expect(rango("medium")).toBeGreaterThan(rango("low"));
    // Descendente: el rango más alto va primero.
    expect(sql.split(" order by ")[1]).toMatch(/end desc nulls last, "cases"\."updated_at"/);
  });

  it("la bandeja general no cambia: created_at desc, sin desempate", async () => {
    expect(await ordenDe({})).toMatch(/^"cases"\."created_at" desc limit /);
  });

  it("selecciona el nombre del analista asignado", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    const sql = consultaListado(datos as never, baseQuery).toSQL().sql;
    expect(sql).toContain("select u.full_name from users u");
  });

  it("trae la clase y el resumen del mensaje tardío sólo si el caso está en «Para responder»", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    const sql = consultaListado(datos as never, baseQuery).toSQL().sql;
    expect(sql).toContain(
      'case when "para_responder_desde" is not null then "mensaje_tardio_tipo" end'
    );
    expect(sql).toContain(
      'case when "para_responder_desde" is not null then "mensaje_tardio_resumen" end'
    );
    // Ni la reserva ni nada del texto del mensaje salen al listado.
    expect(sql).not.toContain("mensaje_tardio_de");
    expect(sql).not.toContain("body_text");
  });

  it("en la vista de descartes trae el motivo, el asunto y el remitente del primer mensaje que entró, y nunca el cuerpo", async () => {
    const { sql } = await consulta({ is_claim: false });
    expect(sql).toContain('"not_relevant_reason"');
    expect(sql).toContain("claim_messages");
    expect(sql).toContain("select m.subject from claim_messages m");
    expect(sql).toContain("select m.from_addr from claim_messages m");
    expect(sql).toContain("m.direction = 'inbound'");
    expect(sql).toContain("order by m.received_at asc");
    expect(sql).not.toContain("body_text");
    expect(sql).not.toContain("body_html");
    // El caso de afuera va calificado: pelado, `"id"` se lee como el de `claim_messages`.
    expect(sql).toContain('m.case_id = "cases"."id"');
  });

  it("las subconsultas del select correlacionan con el caso de afuera, calificado", async () => {
    for (const query of [{}, { is_claim: false }, { cola: "mia" as const }]) {
      const { sql } = await consulta(query);
      // Pelado, `"id"` se lee como el de la propia subconsulta y no empareja con nada.
      expect(sql).not.toMatch(/\b(ef|om|m)\.(case_id|tenant_id) = "(id|tenant_id)"/);
      expect(sql).toMatch(/ef\.case_id = "cases"\."id"\s+and ef\.tenant_id = "cases"\."tenant_id"/);
      expect(sql).toMatch(/om\.case_id = "cases"\."id"\s+and om\.tenant_id = "cases"\."tenant_id"/);
    }
  });

  it("sin is_claim=false el plan por defecto no cambia: ni mensajes ni motivo", async () => {
    for (const query of [{}, { is_claim: true }, { cola: "mia" as const }, { para_responder: true as const }]) {
      const { sql } = await consulta(query);
      expect(sql).not.toContain("claim_messages");
      expect(sql).not.toContain("not_relevant_reason");
    }
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

describe("consultaTablero", () => {
  type Pedido = { status?: string[]; cola?: "mia"; q?: string; page?: number; per_page?: number };
  async function datosSinConexion() {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    return drizzle(async () => ({ rows: [] })) as never;
  }
  async function tablero(query: Pedido = {}) {
    const consulta = consultaTablero(await datosSinConexion(), { ...baseQuery, ...query } as never, "yo-1");
    return consulta?.toSQL();
  }
  const veces = (texto: string, parte: string) => texto.split(parte).length - 1;

  it("las subconsultas correlacionadas van una sola vez, afuera de las ramas, calificadas", async () => {
    const { sql } = (await tablero())!;
    expect(sql).not.toMatch(/\b(ef|om)\.(case_id|tenant_id) = "(id|tenant_id)"/);
    expect(veces(sql, 'om.case_id = "cases"."id"')).toBe(1);
    expect(veces(sql, '(select "id" from "cases" where ')).toBe(6);
  });

  it("una rama por columna, unidas con union all y cada una con su propio límite", async () => {
    const { sql, params } = (await tablero())!;
    expect(veces(sql, " union all ")).toBe(5);
    expect(veces(sql, " limit ")).toBe(6);
    expect(params.filter((p) => p === TARJETAS_POR_COLUMNA)).toHaveLength(6);
    // Cada lado entre paréntesis: sin eso el ORDER BY y el LIMIT de la primera rama serían de toda la unión.
    expect(veces(sql, ") union all (select ")).toBe(5);
    // Seis adentro y uno afuera, que deja cada columna en el orden de la bandeja.
    expect(veces(sql, "order by")).toBe(7);
  });

  it("cada rama pide los estados de su columna y de ninguna otra", async () => {
    const { sql, params } = (await tablero())!;
    expect(veces(sql, '"cases"."status" in (')).toBe(6);
    expect(params).toContain("requiere_especialista");
    expect(params).toContain("listo_para_core");
    expect(params).toContain("procesando");
  });

  it("no lleva ningún predicado de inquilino escrito a mano", async () => {
    const { sql } = (await tablero())!;
    // Las subconsultas correlacionadas emparejan contra el caso de afuera; el filtro por inquilino lo pone la RLS.
    expect(sql).not.toMatch(/tenant_id" = \$\d/);
    expect(sql).not.toMatch(/where[^()]*"cases"\."tenant_id" =/);
  });

  it("el tablero no pagina: ignora page y per_page de la consulta", async () => {
    const { sql, params } = (await tablero({ page: 4, per_page: 100 }))!;
    expect(params).not.toContain(100);
    expect(params).not.toContain(300);
    expect(params.filter((p) => p === TARJETAS_POR_COLUMNA)).toHaveLength(6);
    expect(sql).not.toContain("offset");
  });

  it("con un estado pedido queda una sola rama y no hay unión", async () => {
    const { sql } = (await tablero({ status: ["escalado"] }))!;
    expect(sql).not.toContain("union all");
    expect(veces(sql, " limit ")).toBe(1);
  });

  it("un filtro de estado se queda con la parte de cada columna que cubre", async () => {
    const { sql, params } = (await tablero({ status: ["escalado", "listo"] }))!;
    expect(veces(sql, " union all ")).toBe(1);
    expect(params).toContain("requiere_especialista");
    expect(params).not.toContain("procesando");
  });

  it("un estado crudo cae en la rama de su columna, no en una aparte", async () => {
    const { sql, params } = (await tablero({ status: ["requiere_especialista"] }))!;
    expect(sql).not.toContain("union all");
    expect(params).toContain("requiere_especialista");
  });

  it("un filtro que ninguna columna dibuja no arma consulta", async () => {
    expect(await tablero({ status: ["no_relevante"] })).toBeUndefined();
  });

  it("«Mi cola» conserva su orden en cada rama y afuera", async () => {
    const { sql } = (await tablero({ cola: "mia" }))!;
    expect(veces(sql, '"cases"."updated_at" asc, "cases"."id" asc limit ')).toBe(6);
    expect(veces(sql, 'case "cases"."severity" when')).toBe(7);
  });

  it("los demás filtros viajan en cada rama", async () => {
    const { sql } = (await tablero({ q: "juan" }))!;
    expect(veces(sql, "ilike")).toBeGreaterThanOrEqual(6);
  });
});

describe("consultaConteoPorEstado", () => {
  async function conteo(query: Parameters<typeof consultaConteoPorEstado>[1]) {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    return consultaConteoPorEstado(datos as never, query, "yo-1").toSQL().sql;
  }

  it("cuenta por estado bajo los mismos filtros que la lista", async () => {
    const sql = await conteo({ ...baseQuery, q: "juan", cola: "mia" } as never);
    expect(sql).toContain("count(*)::int");
    expect(sql).toContain("group by");
    expect(sql).toContain("ilike");
    expect(sql).toContain("48 hours");
    expect(sql).not.toContain("limit");
  });

  it("también bajo el filtro de estado: los totales de las columnas son los de lo que se ve", async () => {
    const sql = await conteo({ ...baseQuery, status: ["escalado"] } as never);
    expect(sql).toContain('"cases"."status" in (');
  });

  it("en la misma pasada cuenta las pestañas, que sólo miran la búsqueda y el período", async () => {
    const sql = await conteo({ ...baseQuery, q: "juan", status: ["escalado"] } as never);
    const [conteos, where] = sql.split(' from "cases" where ');
    // El estado sólo filtra el total de las columnas, no el de las pestañas.
    expect(conteos).toMatch(/^select "status", count\(\*\) filter \(where "cases"\."status" in \(\$1, \$2\)\)::int, count\(\*\)::int$/);
    // La búsqueda va una sola vez, en el WHERE.
    expect(where).toContain("ilike");
    expect(where.split(" group by ")[0]).not.toContain('"cases"."status"');
  });
});

describe("listarTablero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("devuelve las tarjetas tal como llegan y el total real de cada columna", async () => {
    const tarjetas = [
      { id: "a", status: "procesando" },
      { id: "b", status: "procesando" },
      { id: "c", status: "requiere_especialista" },
    ];
    vi.mocked(enTenantVarias).mockResolvedValue([
      [
        { status: "procesando", n: 30, pestana: 31 },
        { status: "requiere_especialista", n: 2, pestana: 2 },
        { status: "no_relevante", n: 9, pestana: 9 },
      ],
      tarjetas,
    ] as never);

    const resultado = await listarTablero(CTX, baseQuery as never, "yo-1");

    // Los contadores de las pestañas viajan en el mismo conteo.
    expect(resultado.pestanas).toEqual([
      { status: "procesando", n: 31 },
      { status: "requiere_especialista", n: 2 },
      { status: "no_relevante", n: 9 },
    ]);

    expect(resultado.data).toEqual(tarjetas);
    expect(resultado.totales.procesando).toBe(30);
    expect(resultado.totales.escalado).toBe(2);
    expect(resultado.totales.listo).toBe(0);
    // Lo que el tablero no dibuja no entra en el total.
    expect(resultado.meta).toMatchObject({ total: 32, page: 1, per_page: TARJETAS_POR_COLUMNA });
  });

  it("corre el conteo y la unión en un solo viaje, para el inquilino del contexto", async () => {
    vi.mocked(enTenantVarias).mockResolvedValue([[], []] as never);
    await listarTablero(CTX, baseQuery as never, "yo-1");
    expect(enTenantVarias).toHaveBeenCalledWith({ tenantId: TENANT_ID }, expect.any(Function));

    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const armar = vi.mocked(enTenantVarias).mock.calls[0][1] as (db: unknown) => unknown[];
    expect(armar(drizzle(async () => ({ rows: [] })))).toHaveLength(2);
  });

  it("si ninguna columna entra en el filtro corre sólo el conteo y no devuelve tarjetas", async () => {
    vi.mocked(enTenantVarias).mockResolvedValue([[{ status: "no_relevante", n: 4 }]] as never);

    const resultado = await listarTablero(CTX, { ...baseQuery, status: ["no_relevante"] } as never);

    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const armar = vi.mocked(enTenantVarias).mock.calls[0][1] as (db: unknown) => unknown[];
    expect(armar(drizzle(async () => ({ rows: [] })))).toHaveLength(1);
    expect(resultado.data).toEqual([]);
    expect(resultado.meta.total).toBe(0);
  });

  it("si la consulta falla, lleva el código de Postgres", async () => {
    const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    vi.mocked(enTenantVarias).mockRejectedValue(err);
    await expect(listarTablero(CTX, baseQuery as never)).rejects.toThrow("[listarTablero] query error: 42P01");
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

describe("bandeja por plazo y por complejidad (B10, B13)", () => {
  const ahora = new Date("2026-09-29T15:00:00.000Z");
  const CERRADOS = [...ESTADOS_CERRADOS];
  const cinco = new Date(ahora.getTime() + 5 * 86_400_000).toISOString();

  async function compilar(query: Parameters<typeof buildCaseFilters>[0]) {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const where = buildCaseFilters(query, undefined, ahora);
    expect(where).toBeDefined();
    return new PgDialect().sqlToQuery(where!);
  }

  async function ordenDe(sort: "puntaje_complejidad" | "vence_en" | "created_at", order: "asc" | "desc") {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    return consultaListado(datos as never, { ...baseQuery, sort, order }, "yo-1", ahora)
      .toSQL()
      .sql.split(" order by ")[1];
  }

  it("vencidos: vence_en menor que el ahora que se le pasa, y nada de tenant_id", async () => {
    const { sql: compilado, params } = await compilar({ vencimiento: ["vencidos"] });
    expect(compilado).toContain('"vence_en" <');
    expect(compilado).not.toContain('"vence_en" >=');
    expect(compilado).not.toContain("tenant_id");
    expect(params).toEqual([...CERRADOS, ahora.toISOString()]);
  });

  it("un caso cerrado no entra a ningún filtro de plazo aunque conserve el vencimiento", async () => {
    for (const filtro of ["vencidos", "por_vencer"] as const) {
      const { sql: compilado, params } = await compilar({ vencimiento: [filtro] });
      expect(compilado).toMatch(/"cases"\."status" not in \(\$1, \$2, \$3\) and /);
      expect(params.slice(0, CERRADOS.length)).toEqual(CERRADOS);
    }
  });

  it("por vencer: desde ahora, hasta cinco días después, sin incluir el borde de arriba", async () => {
    const { sql: compilado, params } = await compilar({ vencimiento: ["por_vencer"] });
    expect(compilado).toContain('"vence_en" >=');
    expect(compilado).toContain('"vence_en" <');
    expect(params).toEqual([...CERRADOS, ahora.toISOString(), cinco]);
  });

  it("los dos plazos a la vez son la unión de los rangos", async () => {
    const { sql: compilado } = await compilar({ vencimiento: ["vencidos", "por_vencer"] });
    expect(compilado).toContain(" or ");
  });

  it.each([
    ["baja", 0, 33],
    ["media", 34, 66],
    ["alta", 67, 100],
  ] as const)("complejidad %s es el rango cerrado %d a %d", async (banda, desde, hasta) => {
    const { sql: compilado, params } = await compilar({ complejidad: [banda] });
    expect(compilado).toContain('"puntaje_complejidad" >=');
    expect(compilado).toContain('"puntaje_complejidad" <=');
    expect(compilado).not.toContain("tenant_id");
    expect(params).toEqual([desde, hasta]);
  });

  it("sin los filtros nuevos no agrega condiciones", () => {
    expect(buildCaseFilters({ vencimiento: undefined, complejidad: undefined }, undefined, ahora)).toBeUndefined();
  });

  it("el listado y el conteo miden contra el mismo instante", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const { consultaConteo } = await import("@/server/cases/list");
    const datos = drizzle(async () => ({ rows: [] }));
    const query = { ...baseQuery, vencimiento: ["vencidos"] as ["vencidos"] };
    const lista = consultaListado(datos as never, query, "yo-1", ahora).toSQL();
    const conteo = consultaConteo(datos as never, query, "yo-1", ahora).toSQL();
    expect(lista.params).toContain(ahora.toISOString());
    expect(conteo.params).toEqual([...CERRADOS, ahora.toISOString()]);
  });

  it("ordenar por puntaje manda los nulos al final y desempata por id", async () => {
    expect(await ordenDe("puntaje_complejidad", "asc")).toMatch(/^"cases"\."puntaje_complejidad" asc nulls last, "cases"\."id" asc /);
    expect(await ordenDe("puntaje_complejidad", "desc")).toMatch(/^"cases"\."puntaje_complejidad" desc nulls last, "cases"\."id" asc /);
  });

  it("ordenar por vencimiento cuenta sólo los casos abiertos, manda los nulos al final y desempata por id", async () => {
    const vigente = String.raw`case when "cases"\."status" not in \(\$\d+, \$\d+, \$\d+\) then "cases"\."vence_en" end`;
    expect(await ordenDe("vence_en", "asc")).toMatch(new RegExp(String.raw`^${vigente} asc nulls last, "cases"\."id" asc `));
    expect(await ordenDe("vence_en", "desc")).toMatch(new RegExp(String.raw`^${vigente} desc nulls last, "cases"\."id" asc `));
  });

  it("las demás columnas se ordenan como siempre, sin nulls last ni desempate", async () => {
    const orden = await ordenDe("created_at", "desc");
    expect(orden).toMatch(/^"cases"\."created_at" desc /);
    expect(orden).not.toContain("nulls last");
  });

  it("el listado trae las dos columnas nuevas", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const datos = drizzle(async () => ({ rows: [] }));
    const sql = consultaListado(datos as never, baseQuery, "yo-1", ahora).toSQL().sql;
    expect(sql).toMatch(
      /"para_responder_desde", case when "status" not in \(\$\d+, \$\d+, \$\d+\) then "vence_en" end, "puntaje_complejidad"/
    );
  });
});

describe("CaseQuerySchema — vencimiento, complejidad y orden nuevos", () => {
  it("acepta uno o varios valores del enum", async () => {
    const { CaseQuerySchema } = await import("@/lib/schemas/cases");
    const r = CaseQuerySchema.parse({ vencimiento: ["vencidos", "por_vencer"], complejidad: "alta" });
    expect(r.vencimiento).toEqual(["vencidos", "por_vencer"]);
    expect(r.complejidad).toEqual(["alta"]);
  });

  it.each([{ vencimiento: ["mañana"] }, { complejidad: ["altisima"] }, { sort: "puntaje" }])(
    "rechaza %j",
    async (raw) => {
      const { CaseQuerySchema } = await import("@/lib/schemas/cases");
      expect(CaseQuerySchema.safeParse(raw).success).toBe(false);
    }
  );

  it("acepta las dos columnas de orden nuevas", async () => {
    const { CaseQuerySchema } = await import("@/lib/schemas/cases");
    expect(CaseQuerySchema.parse({ sort: "vence_en" }).sort).toBe("vence_en");
    expect(CaseQuerySchema.parse({ sort: "puntaje_complejidad" }).sort).toBe("puntaje_complejidad");
  });
});
