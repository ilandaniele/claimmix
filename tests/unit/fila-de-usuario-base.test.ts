/**
 * `filaDeUsuario` suma el estado de la base del inquilino (`tenant_bases`, 0050)
 * a la MISMA consulta de siempre: es un LEFT JOIN, no un viaje más. Acá no se
 * simula la cadena de drizzle: se arma la consulta de verdad contra el esquema y
 * se mira el SQL que sale y lo que hace con las filas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEjecutar } = vi.hoisted(() => ({ mockEjecutar: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { db: drizzle(mockEjecutar) };
});

import { filaDeUsuario, olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";

const CREADA_AT = "2026-10-08T12:00:00.000Z";
const INQUILINO_CREADO = "2026-01-02T03:04:05.000Z";

/** Una fila en el orden del select: id, tenant_id, role, full_name, locale, plan, billing_status, autoalta, base, baseDesde. */
function fila(base: string | null, baseDesde: string | null) {
  return ["u-1", "t-1", "analyst", "Ana", "es-AR", "piloto", "trial", false, base, baseDesde];
}

beforeEach(() => {
  mockEjecutar.mockReset();
  olvidarFilaDeUsuario();
});

describe("filaDeUsuario y la base del inquilino", () => {
  it("con fila en tenant_bases trae el estado y desde cuándo", async () => {
    mockEjecutar.mockResolvedValue({ rows: [fila("creando", CREADA_AT)] });

    const f = await filaDeUsuario("u-1");

    expect(f?.base).toBe("creando");
    expect(f?.baseDesde).toEqual(new Date(CREADA_AT));
  });

  it.each(["creando", "lista", "fallida", "borrada"] as const)("deja pasar el estado %s tal cual", async (estado) => {
    mockEjecutar.mockResolvedValue({ rows: [fila(estado, CREADA_AT)] });

    expect((await filaDeUsuario("u-1"))?.base).toBe(estado);
  });

  it("sin fila: base null y baseDesde es la fecha del inquilino", async () => {
    // El coalesce lo hace la base: acá llega ya resuelto a tenants.created_at.
    mockEjecutar.mockResolvedValue({ rows: [fila(null, INQUILINO_CREADO)] });

    const f = await filaDeUsuario("u-1");

    expect(f?.base).toBeNull();
    expect(f?.baseDesde).toEqual(new Date(INQUILINO_CREADO));
  });

  it("si la fecha llega como Date o nula, no tira", async () => {
    mockEjecutar.mockResolvedValueOnce({ rows: [fila("lista", new Date(CREADA_AT) as unknown as string)] });
    expect((await filaDeUsuario("u-1"))?.baseDesde).toEqual(new Date(CREADA_AT));

    olvidarFilaDeUsuario();
    mockEjecutar.mockResolvedValueOnce({ rows: [fila("lista", null)] });
    expect((await filaDeUsuario("u-1"))?.baseDesde).toBeNull();
  });

  it("sigue siendo UNA sola consulta, y la base entra por un LEFT JOIN", async () => {
    mockEjecutar.mockResolvedValue({ rows: [fila("lista", CREADA_AT)] });

    await filaDeUsuario("u-1");

    expect(mockEjecutar).toHaveBeenCalledTimes(1);
    const sql = String(mockEjecutar.mock.calls[0]![0]).replace(/\s+/g, " ");
    expect(sql).toMatch(/inner join "tenants" on "tenants"\."id" = "users"\."tenant_id"/);
    expect(sql).toMatch(/left join "tenant_bases" on "tenants"\."id" = "tenant_bases"\."tenant_id"/);
    expect(sql.match(/ join /g)).toHaveLength(2);
  });

  it("el estado y la fecha salen en el select, con el coalesce a la fecha del inquilino", async () => {
    mockEjecutar.mockResolvedValue({ rows: [fila("lista", CREADA_AT)] });

    await filaDeUsuario("u-1");

    const sql = String(mockEjecutar.mock.calls[0]![0]).replace(/\s+/g, " ");
    expect(sql).toContain('"tenant_bases"."estado"');
    expect(sql).toContain('coalesce("tenant_bases"."creada_at", "tenants"."created_at")');
  });

  it("la segunda lectura sale de la caché: no hay otra consulta", async () => {
    mockEjecutar.mockResolvedValue({ rows: [fila("lista", CREADA_AT)] });

    const a = await filaDeUsuario("u-1");
    const b = await filaDeUsuario("u-1");

    expect(b).toBe(a);
    expect(mockEjecutar).toHaveBeenCalledTimes(1);
  });

  it("un usuario que no existe sigue dando null", async () => {
    mockEjecutar.mockResolvedValue({ rows: [] });

    expect(await filaDeUsuario("fantasma")).toBeNull();
  });
});
