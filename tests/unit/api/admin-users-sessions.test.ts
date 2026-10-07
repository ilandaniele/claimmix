/**
 * DELETE /api/admin/users/:id/sessions: un admin cierra las sesiones de otra
 * persona de su inquilino. Sin sesión o sin rol no se toca nada, una persona de
 * otro inquilino no existe, uno no se cierra a sí mismo, sólo un owner toca a un
 * owner, y lo que se cerró queda auditado con quién lo hizo. Si el borrado
 * falla no se audita.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  enTenant: vi.fn(),
  cerrarSesiones: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/auth/sesiones", () => ({ cerrarSesiones: m.cerrarSesiones }));
vi.mock("@/data/scope", () => ({ enTenant: m.enTenant }));
vi.mock("@/lib/db", async () => {
  const { users } = await import("@/lib/db/schema");
  return { db: {}, tables: { users } };
});
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: m.writeAuditLog,
}));

import { DELETE } from "@/app/api/admin/users/[id]/sessions/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const ADMIN_ID = "20000000-0000-0000-0000-000000000001";
const OBJETIVO_ID = "30000000-0000-0000-0000-000000000001";

const comoAdmin = (role: string) => ({
  user: { id: ADMIN_ID },
  userRow: { id: ADMIN_ID, tenant_id: TENANT_ID, role },
});

const cerrar = (id: string) =>
  DELETE(
    new NextRequest(`http://localhost/api/admin/users/${id}/sessions`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAdmin.mockResolvedValue(comoAdmin("admin"));
  elObjetivoEs([{ id: OBJETIVO_ID, role: "analyst" }]);
  m.cerrarSesiones.mockResolvedValue(2);
  m.writeAuditLog.mockResolvedValue(undefined);
});

function elObjetivoEs(filas: Array<{ id: string; role: string }>) {
  m.enTenant.mockImplementation(async (ctx: { tenantId: string }, armar: (db: unknown) => unknown) => {
    expect(ctx).toEqual({ tenantId: TENANT_ID });
    const cadena = {
      select: () => cadena,
      from: () => cadena,
      where: () => cadena,
      limit: () => Promise.resolve(filas),
    };
    await armar(cadena);
    return filas;
  });
}

describe("quién entra", () => {
  it.each([
    ["sin sesión", "MISSING_SESSION", 401],
    ["sin rol de admin", "FORBIDDEN_ROLE", 403],
  ])("%s no llega a la base ni a las sesiones", async (_caso, codigo, estado) => {
    m.requireAdmin.mockRejectedValue(new AppError(codigo as "FORBIDDEN_ROLE"));

    expect((await cerrar(OBJETIVO_ID)).status).toBe(estado);
    expect(m.enTenant).not.toHaveBeenCalled();
    expect(m.cerrarSesiones).not.toHaveBeenCalled();
    expect(m.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("a quién se le cierran", () => {
  it("un id que no es uuid es un 404 sin consultar", async () => {
    expect((await cerrar("no-es-un-uuid")).status).toBe(404);
    expect(m.enTenant).not.toHaveBeenCalled();
    expect(m.cerrarSesiones).not.toHaveBeenCalled();
  });

  it("alguien que no está en el inquilino es un 404 y no se cierra nada", async () => {
    elObjetivoEs([]);

    expect((await cerrar(OBJETIVO_ID)).status).toBe(404);
    expect(m.cerrarSesiones).not.toHaveBeenCalled();
    expect(m.writeAuditLog).not.toHaveBeenCalled();
  });

  it("uno mismo es un 400 que manda al menú, sin tocar nada", async () => {
    const res = await cerrar(ADMIN_ID);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Cerrá tu propia sesión desde el menú.");
    expect(m.cerrarSesiones).not.toHaveBeenCalled();
    expect(m.writeAuditLog).not.toHaveBeenCalled();
  });

  it("un admin contra un owner es un 403 y no se cierra nada", async () => {
    elObjetivoEs([{ id: OBJETIVO_ID, role: "owner" }]);

    expect((await cerrar(OBJETIVO_ID)).status).toBe(403);
    expect(m.cerrarSesiones).not.toHaveBeenCalled();
    expect(m.writeAuditLog).not.toHaveBeenCalled();
  });

  it("un owner sí puede con otro owner", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));
    elObjetivoEs([{ id: OBJETIVO_ID, role: "owner" }]);

    expect((await cerrar(OBJETIVO_ID)).status).toBe(200);
    expect(m.cerrarSesiones).toHaveBeenCalledWith(OBJETIVO_ID);
  });
});

describe("lo que se cierra y lo que queda escrito", () => {
  it("responde cuántas cerró y deja una fila de auditoría con quién fue", async () => {
    const res = await cerrar(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sesiones_cerradas: 2 });
    expect(m.cerrarSesiones).toHaveBeenCalledTimes(1);
    expect(m.cerrarSesiones).toHaveBeenCalledWith(OBJETIVO_ID);
    expect(m.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(m.writeAuditLog).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      actor_id: ADMIN_ID,
      event_type: "auth.user_sessions_revoked",
      target_type: "user",
      target_id: OBJETIVO_ID,
      payload: { sesiones_cerradas: 2 },
    });
  });

  it("alguien sin sesiones abiertas también es un 200, con cero", async () => {
    m.cerrarSesiones.mockResolvedValue(0);

    const res = await cerrar(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sesiones_cerradas: 0 });
  });

  it("si el borrado falla es un 500 y no queda un «0 cerradas» como éxito", async () => {
    m.cerrarSesiones.mockRejectedValue(new Error("conexión caída"));

    const res = await cerrar(OBJETIVO_ID);

    expect(res.status).toBe(500);
    expect(m.writeAuditLog).not.toHaveBeenCalled();
  });
});
