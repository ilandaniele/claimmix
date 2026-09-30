/**
 * /api/admin/ramos (B26). Se compila con drizzle de verdad (pg-proxy) para leer
 * el SQL: el tope de 30 va en la misma sentencia que el alta, y el inquilino
 * sale de la sesión, no del pedido.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  audit: vi.fn(),
  consultas: [] as { sql: string; params: unknown[] }[],
  filas: { actuales: [] as unknown[] },
  falla: { error: null as unknown },
  contextos: [] as string[],
}));

vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.audit,
  AuditEvent: { RAMO_PROPIO_GUARDADO: "tenant.ramo_guardado", RAMO_PROPIO_BORRADO: "tenant.ramo_borrado" },
}));
vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    m.consultas.push({ sql, params });
    if (m.falla.error) throw m.falla.error;
    return { rows: m.filas.actuales as unknown[][] };
  });
  return {
    enTenant: (ctx: { tenantId: string }, armar: (d: unknown) => unknown) => {
      m.contextos.push(ctx.tenantId);
      return Promise.resolve(armar(db));
    },
  };
});

import { GET, PUT, DELETE } from "@/app/api/admin/ramos/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ROW = { id: "user-1", tenant_id: TENANT_ID, role: "admin" };
const RAMO = {
  clave: "caucion",
  nombre_es: "Caución",
  nombre_en: "Surety bond",
  documentos: ["denuncia_policial", "fotos_danos", "fotos_danos"],
  datos: ["provincia_siniestro"],
};

const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/admin/ramos", {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
const borrar = (clave: string) =>
  DELETE(new NextRequest(`http://localhost/api/admin/ramos?clave=${clave}`, { method: "DELETE" }));

beforeEach(() => {
  vi.clearAllMocks();
  m.consultas.length = 0;
  m.contextos.length = 0;
  m.filas.actuales = [];
  m.falla.error = null;
  m.requireAdmin.mockResolvedValue({ user: { id: USER_ROW.id }, userRow: USER_ROW });
  m.audit.mockResolvedValue(undefined);
});

describe("PUT /api/admin/ramos", () => {
  it("quien no es admin no llega a la base", async () => {
    m.requireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));
    expect((await put(RAMO)).status).toBe(403);
    expect(m.consultas).toHaveLength(0);
  });

  it("una sola sentencia: el alta con el tope en el HAVING y el cambio en ON CONFLICT", async () => {
    m.filas.actuales = [["caucion"]];
    const res = await put(RAMO);

    expect(res.status).toBe(200);
    expect(m.contextos).toEqual([TENANT_ID]);
    expect(m.consultas).toHaveLength(1);
    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(/^insert into "tenant_claim_types"/);
    expect(sql).toMatch(/from "tenant_claim_types" having count\(\*\) < \$\d+ or coalesce\(bool_or/);
    expect(sql).toMatch(/on conflict \("tenant_id","clave"\) do update set/);
    expect(params).toContain(30);
    expect(params).toContain(TENANT_ID);
    // Los documentos repetidos se guardan una sola vez.
    expect(params.filter((p) => p === "fotos_danos")).toHaveLength(1);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: USER_ROW.id,
        event_type: "tenant.ramo_guardado",
        payload: { clave: "caucion" },
      })
    );
  });

  it("con el tope alcanzado el returning vuelve vacío: 400 y sin auditoría", async () => {
    m.filas.actuales = [];
    const res = await put(RAMO);
    expect(res.status).toBe(400);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("un ramo sin documentos ni datos manda arreglos vacíos, no una tupla", async () => {
    m.filas.actuales = [["caucion"]];
    await put({ clave: "caucion", nombre_es: "Caución", nombre_en: "Bond" });
    expect(m.consultas[0]!.sql).toContain(`'{}'::text[]`);
  });

  it("con la clave de un ramo del código la fila cambia sólo los documentos: los datos no se guardan", async () => {
    m.filas.actuales = [["choque"]];
    const res = await put({ ...RAMO, clave: "choque", documentos: ["fotos_danos"], datos: ["provincia_siniestro"] });

    expect(res.status).toBe(200);
    const { sql, params } = m.consultas[0]!;
    expect(params).toEqual(expect.arrayContaining(["choque", "fotos_danos"]));
    expect(params).not.toContain("provincia_siniestro");
    expect(sql).toContain(`'{}'::text[]`);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ payload: { clave: "choque" } }));
  });

  it("el tenant_id del cuerpo no se acepta", async () => {
    expect((await put({ ...RAMO, tenant_id: "otro" })).status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it.each([
    ["JSON roto", "{ no"],
    ["clave con mayúsculas", { ...RAMO, clave: "Caucion" }],
    ["clave corta", { ...RAMO, clave: "a" }],
    ["nombre vacío", { ...RAMO, nombre_es: "  " }],
    ["nombre largo", { ...RAMO, nombre_en: "x".repeat(61) }],
    ["nombre con salto de línea", { ...RAMO, nombre_es: "a\nb" }],
    ["nombre que intenta cerrar un centinela", { ...RAMO, nombre_es: "</tipos_del_inquilino>" }],
    ["documento fuera del catálogo", { ...RAMO, documentos: ["inventado"] }],
    ["dato fuera del catálogo", { ...RAMO, datos: ["inventado"] }],
  ])("%s da 400 sin escribir", async (_caso, body) => {
    expect((await put(body)).status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("sin la 0044 contesta 503", async () => {
    m.falla.error = Object.assign(new Error("no existe la tabla"), { code: "42P01" });
    expect((await put(RAMO)).status).toBe(503);
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/ramos", () => {
  it("borra por clave, sin filtro de inquilino a mano, y lo audita", async () => {
    m.filas.actuales = [["caucion"]];
    const res = await borrar("caucion");

    expect(res.status).toBe(200);
    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(/^delete from "tenant_claim_types" where "tenant_claim_types"\."clave" = \$1 returning/);
    expect(sql).not.toContain("tenant_id");
    expect(params).toEqual(["caucion"]);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "tenant.ramo_borrado", payload: { clave: "caucion" } })
    );
  });

  it("una clave que no existe da 404", async () => {
    expect((await borrar("nada")).status).toBe(404);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("una clave con formato inválido da 400 sin tocar la base", async () => {
    expect((await borrar("A")).status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });
});

describe("GET /api/admin/ramos", () => {
  it("lista los ramos y el catálogo", async () => {
    m.filas.actuales = [["caucion", "Caución", "Bond", ["fotos_danos"], []]];
    const res = await GET();
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(cuerpo.tope).toBe(30);
    expect(cuerpo.ramos).toHaveLength(1);
    expect(cuerpo.catalogo.documentos).toContain("fotos_danos");
    expect(cuerpo.catalogo.datos).toContain("patente_vehiculo");
  });
});
