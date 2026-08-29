/**
 * Los listados de clientes y de pólizas, sin pasar por HTTP.
 *
 * Estas consultas vivían adentro del route handler. Al sacarlas a
 * `src/server/{customers,policies}/list.ts`, el test de la ruta pasó a mockear
 * los módulos —que es lo correcto para probar la guarda de rol— y la lógica de
 * filtrado se quedó sin nadie que la mire. La cobertura de funciones lo cantó
 * enseguida: 72.86% contra un piso de 73%.
 *
 * Así que se prueba acá, que además es más barato: no hace falta fabricar una
 * petición con sesión para saber si el filtro por DNI arma un WHERE.
 *
 * Lo que se afirma es lo que puede salir mal de verdad:
 *   · Sin filtros no tiene que haber WHERE. Un `and()` vacío que devuelva algo
 *     definido convertiría «traeme todos» en «traeme ninguno».
 *   · El conteo y la página tienen que llevar EXACTAMENTE el mismo WHERE. Si se
 *     separan, la paginación miente: 40 resultados repartidos en 3 páginas.
 *   · Las dos consultas tienen que ir en un solo lote, o son dos fotos de la
 *     tabla en momentos distintos.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/data/scope", () => ({
  enTenant: vi.fn(),
  enTenantVarias: vi.fn(),
}));

import { enTenantVarias } from "@/data/scope";
import { listCustomers } from "@/server/customers/list";
import { listPolicies } from "@/server/policies/list";
import { paginarEnTenant } from "@/lib/db/paginacion";
import { customers, policies } from "@/lib/db/schema";

const CTX = { tenantId: "tenant-1" };

interface Cadena {
  columnas: unknown;
  tabla?: unknown;
  join?: unknown;
  where?: unknown;
  tieneWhere: boolean;
  limite?: number;
  desplazamiento?: number;
}

/**
 * Un `db` de mentira que anota lo que le van pidiendo.
 *
 * No imita a drizzle: sólo registra la cadena de llamadas, que es lo único que
 * este test necesita mirar.
 */
function crearDb() {
  const cadenas: Cadena[] = [];
  const db = {
    select(columnas: unknown) {
      const c: Cadena = { columnas, tieneWhere: false };
      cadenas.push(c);
      const eslabon = {
        from(t: unknown) {
          c.tabla = t;
          return eslabon;
        },
        leftJoin(t: unknown) {
          c.join = t;
          return eslabon;
        },
        where(w: unknown) {
          c.where = w;
          c.tieneWhere = true;
          return eslabon;
        },
        orderBy() {
          return eslabon;
        },
        limit(n: number) {
          c.limite = n;
          return eslabon;
        },
        offset(n: number) {
          c.desplazamiento = n;
          return eslabon;
        },
      };
      return eslabon;
    },
  };
  return { db, cadenas };
}

/** Corre el listado y devuelve las dos consultas que le pidió al lote. */
async function espiar(
  correr: () => Promise<unknown>,
  filas: unknown[] = [],
  total = 0
) {
  let visto: { ctx: unknown; cadenas: Cadena[] } | null = null;

  vi.mocked(enTenantVarias).mockImplementation((async (
    ctx: unknown,
    armar: (db: unknown) => unknown
  ) => {
    const { db, cadenas } = crearDb();
    armar(db);
    visto = { ctx, cadenas };
    return [[{ n: total }], filas];
  }) as never);

  const resultado = await correr();
  if (!visto) throw new Error("el listado no pasó por enTenantVarias");
  return { resultado, ...(visto as { ctx: unknown; cadenas: Cadena[] }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listCustomers", () => {
  it("sin filtros no arma ningún WHERE", async () => {
    const { cadenas } = await espiar(() =>
      listCustomers(CTX, { page: 1, per_page: 25 })
    );

    // `and()` sin condiciones devuelve undefined, y eso es lo que corresponde:
    // un WHERE vacío pero definido sería «no traigas nada».
    expect(cadenas).toHaveLength(2);
    expect(cadenas[0].where).toBeUndefined();
    expect(cadenas[1].where).toBeUndefined();
  });

  it.each([
    ["dni", { dni: "30111222" }],
    ["email", { email: "a@b.com" }],
    ["nombre", { search: "perez" }],
  ])("con filtro por %s arma un WHERE", async (_nombre, filtro) => {
    const { cadenas } = await espiar(() =>
      listCustomers(CTX, { page: 1, per_page: 25, ...filtro })
    );

    expect(cadenas[1].where).toBeDefined();
  });

  it("el conteo y la página llevan el MISMO where", async () => {
    const { cadenas } = await espiar(() =>
      listCustomers(CTX, { page: 1, per_page: 25, dni: "30111222" })
    );

    expect(cadenas[0].where).toBeDefined();
    // Misma referencia, no dos objetos equivalentes: si alguien arma el filtro
    // dos veces, el día que uno cambie el otro se queda atrás en silencio.
    expect(cadenas[0].where).toBe(cadenas[1].where);
  });

  it("las dos consultas van en un solo lote", async () => {
    const { ctx } = await espiar(() => listCustomers(CTX, { page: 1, per_page: 25 }));

    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    expect(ctx).toEqual({ tenantId: "tenant-1" });
  });

  it("la página se traduce a limit y offset", async () => {
    const { cadenas } = await espiar(() =>
      listCustomers(CTX, { page: 3, per_page: 10 })
    );

    expect(cadenas[1].limite).toBe(10);
    expect(cadenas[1].desplazamiento).toBe(20);
  });

  it("cuenta sobre la tabla de clientes, no sobre otra cosa", async () => {
    const { cadenas } = await espiar(() =>
      listCustomers(CTX, { page: 1, per_page: 25 })
    );

    expect(cadenas[0].tabla).toBe(customers);
  });

  it("devuelve las filas y el total que trajo el lote", async () => {
    const filas = [{ id: "c1" }, { id: "c2" }];
    const { resultado } = await espiar(
      () => listCustomers(CTX, { page: 1, per_page: 25 }),
      filas,
      2
    );

    expect(resultado).toEqual({
      data: filas,
      meta: { total: 2, page: 1, per_page: 25, pages: 1 },
    });
  });
});

describe("listPolicies", () => {
  it("sin filtros no arma ningún WHERE", async () => {
    const { cadenas } = await espiar(() =>
      listPolicies(CTX, { page: 1, per_page: 25 })
    );

    expect(cadenas[0].where).toBeUndefined();
    expect(cadenas[1].where).toBeUndefined();
  });

  it.each([
    ["customer_id", { customer_id: "00000000-0000-4000-8000-000000000001" }],
    ["policy_number", { policy_number: "POL-1" }],
    ["status", { status: "active" as const }],
  ])("con filtro por %s arma un WHERE", async (_nombre, filtro) => {
    const { cadenas } = await espiar(() =>
      listPolicies(CTX, { page: 1, per_page: 25, ...filtro })
    );

    expect(cadenas[1].where).toBeDefined();
  });

  it("el conteo y la página llevan el MISMO where", async () => {
    const { cadenas } = await espiar(() =>
      listPolicies(CTX, { page: 1, per_page: 25, policy_number: "POL-1" })
    );

    expect(cadenas[0].where).toBe(cadenas[1].where);
  });

  it("cuenta sobre pólizas sin el join", async () => {
    const { cadenas } = await espiar(() =>
      listPolicies(CTX, { page: 1, per_page: 25 })
    );

    // El join es a la izquierda: no cambia cuántas pólizas hay, así que
    // contarlo con el join adentro sería pagarlo para nada.
    expect(cadenas[0].tabla).toBe(policies);
    expect(cadenas[0].join).toBeUndefined();
    expect(cadenas[1].join).toBe(customers);
  });
});

describe("paginarEnTenant", () => {
  it("calcula las páginas hacia arriba", async () => {
    vi.mocked(enTenantVarias).mockResolvedValue([[{ n: 55 }], []] as never);

    const pagina = await paginarEnTenant(
      CTX,
      { tabla: customers, page: 2, per_page: 20 },
      () => ({})
    );

    // 55 en páginas de 20 son 3 páginas, no 2: la última va por la mitad.
    expect(pagina.meta).toEqual({ total: 55, page: 2, per_page: 20, pages: 3 });
  });

  it("sin resultados, cero páginas y no rompe", async () => {
    vi.mocked(enTenantVarias).mockResolvedValue([[], []] as never);

    const pagina = await paginarEnTenant(
      CTX,
      { tabla: customers, page: 1, per_page: 25 },
      () => ({})
    );

    expect(pagina.meta.total).toBe(0);
    expect(pagina.meta.pages).toBe(0);
    expect(pagina.data).toEqual([]);
  });
});
