/**
 * /api/admin/formulario-web (B17). Drizzle de verdad (pg-proxy) para leer el
 * SQL: el enlace se fija al crear y el `set` del ON CONFLICT no lo toca.
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

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.audit,
  AuditEvent: { FORMULARIO_WEB_CAMBIADO: "tenant.formulario_web_cambiado" },
}));
vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    m.consultas.push({ sql, params });
    if (m.falla.error) throw m.falla.error;
    return { rows: m.filas.actuales as unknown[][] };
  });
  return {
    enControl: (ctx: { tenantId: string }, armar: (d: unknown) => unknown) => {
      m.contextos.push(ctx.tenantId);
      return Promise.resolve(armar(db));
    },
  };
});

import { GET, PUT } from "@/app/api/admin/formulario-web/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ROW = { id: "user-1", tenant_id: TENANT_ID, role: "admin" };

const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/admin/formulario-web", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  m.consultas.length = 0;
  m.contextos.length = 0;
  m.filas.actuales = [];
  m.falla.error = null;
  m.requireAdmin.mockResolvedValue({ user: { id: USER_ROW.id }, userRow: USER_ROW });
  m.audit.mockResolvedValue(undefined);
});

describe("PUT /api/admin/formulario-web", () => {
  it("quien no es admin no llega a la base", async () => {
    m.requireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));
    expect((await put({ activo: true })).status).toBe(403);
    expect(m.consultas).toHaveLength(0);
  });

  it("crea con el enlace elegido y el inquilino de la sesión, y el ON CONFLICT no toca el enlace", async () => {
    m.filas.actuales = [["mi-aseguradora", true]];
    const res = await put({ activo: true, slug: "mi-aseguradora" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ formulario: { slug: "mi-aseguradora", activo: true } });
    expect(m.contextos).toEqual([TENANT_ID]);
    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(/^insert into "formulario_web"/);
    const alConflicto = sql.split(/on conflict/)[1]!.split(/returning/)[0]!;
    expect(alConflicto).toMatch(/^ \("tenant_id"\) do update set/);
    expect(alConflicto).toContain(`"activo" = excluded.activo`);
    expect(alConflicto).not.toContain(`"slug"`);
    expect(params).toContain("mi-aseguradora");
    expect(params).toContain(TENANT_ID);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: "user-1",
        event_type: "tenant.formulario_web_cambiado",
        payload: { activo: true },
      })
    );
  });

  it("sin enlace inventa uno con formato válido", async () => {
    m.filas.actuales = [["denuncia-abcd1234", true]];
    await put({ activo: true });
    const slug = m.consultas[0]!.params.find((p) => typeof p === "string" && p.startsWith("denuncia-"));
    expect(slug).toMatch(/^denuncia-[0-9a-f]{8}$/);
  });

  it.each([
    { activo: true, slug: "AB" },
    { activo: true, slug: "con espacios" },
    { activo: true, slug: "-empieza-con-guion" },
    { activo: true, slug: "12345678-1234-1234-1234-123456789012" },
    { activo: "si" },
    { activo: true, tenant_id: "20000000-0000-0000-0000-000000000002" },
  ])("rechaza %j sin tocar la base", async (cuerpo) => {
    expect((await put(cuerpo)).status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("un enlace ya tomado por otro inquilino da 400, no 409", async () => {
    m.falla.error = Object.assign(new Error("duplicate"), { code: "23505" });
    const res = await put({ activo: true, slug: "tomado-por-otro" });
    expect(res.status).toBe(400);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("un enlace de SLUGS_DE_DEV da 400 como uno tomado, sin tocar la base", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "otra-aseguradora, Denuncia-Dev");
    for (const slug of ["otra-aseguradora", "denuncia-dev"]) {
      const res = await put({ activo: true, slug });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toBe("Ese enlace ya está en uso.");
    }
    expect(m.consultas).toHaveLength(0);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("con SLUGS_DE_DEV un enlace que no está en la lista se crea igual", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "otra-aseguradora");
    m.filas.actuales = [["mi-aseguradora", true]];
    expect((await put({ activo: true, slug: "mi-aseguradora" })).status).toBe(200);
    expect(m.consultas).toHaveLength(1);
  });

  it("sin la 0044 responde 503 MIGRACION_PENDIENTE", async () => {
    m.falla.error = Object.assign(new Error("no existe"), { code: "42P01" });
    const res = await put({ activo: true, slug: "mi-aseguradora" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("MIGRACION_PENDIENTE");
  });
});

describe("GET /api/admin/formulario-web", () => {
  it("devuelve el formulario del inquilino o null", async () => {
    m.filas.actuales = [["mi-aseguradora", false]];
    expect(await (await GET()).json()).toEqual({ formulario: { slug: "mi-aseguradora", activo: false } });
    m.filas.actuales = [];
    expect(await (await GET()).json()).toEqual({ formulario: null });
    expect(m.contextos).toEqual([TENANT_ID, TENANT_ID]);
  });
});
