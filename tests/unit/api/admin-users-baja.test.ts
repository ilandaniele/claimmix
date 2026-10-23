/**
 * DELETE /api/admin/users/:id: un admin da de baja a otra persona de su
 * inquilino, y PATCH { activo: true } la vuelve a habilitar. Uno no se da de baja
 * a sí mismo, sólo un owner toca a un owner (así al espacio siempre le queda
 * quien lo administre), una persona de otro inquilino no existe, y la baja se
 * marca antes de cerrar las sesiones, olvida la fila cacheada y queda auditada.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AppError } from "@/lib/errors";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  enControl: vi.fn(),
  cerrarSesiones: vi.fn(),
  writeAuditLog: vi.fn(),
  espejarSinFallar: vi.fn(),
  olvidarFilaDeUsuario: vi.fn(),
  /** Lo que devuelve cada consulta, en orden. */
  respuestas: [] as unknown[][],
  consultas: [] as Array<{ tipo: string; set?: Record<string, unknown>; where?: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/auth/sesiones", () => ({ cerrarSesiones: m.cerrarSesiones }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ olvidarFilaDeUsuario: m.olvidarFilaDeUsuario }));
vi.mock("@/server/bases/espejar-sin-fallar", () => ({ espejarSinFallar: m.espejarSinFallar }));
vi.mock("@/data/scope", () => ({ enControl: m.enControl }));
vi.mock("@/lib/db", async () => {
  const { users } = await import("@/lib/db/schema");
  return { db: {}, tables: { users } };
});
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: m.writeAuditLog,
}));

import { DELETE, PATCH } from "@/app/api/admin/users/[id]/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const ADMIN_ID = "20000000-0000-0000-0000-000000000001";
const OBJETIVO_ID = "30000000-0000-0000-0000-000000000001";
const FECHA = "2026-10-22T12:00:00.000Z";
const FILA = { id: OBJETIVO_ID, full_name: "Ana", role: "analyst", created_at: FECHA, dado_de_baja_en: FECHA };

const comoAdmin = (role: string) => ({
  user: { id: ADMIN_ID },
  userRow: { id: ADMIN_ID, tenant_id: TENANT_ID, role },
});

const contexto = (id: string) => ({ params: Promise.resolve({ id }) });
const darDeBaja = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/admin/users/${id}`, { method: "DELETE" }), contexto(id));
const habilitar = (id: string) =>
  PATCH(
    new NextRequest(`http://localhost/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ activo: true }) }),
    contexto(id)
  );

const enSql = (where: unknown) => new PgDialect().sqlToQuery(where as SQL);

beforeEach(() => {
  vi.clearAllMocks();
  m.respuestas = [[FILA]];
  m.consultas = [];
  m.requireAdmin.mockResolvedValue(comoAdmin("admin"));
  m.cerrarSesiones.mockResolvedValue(2);
  m.writeAuditLog.mockResolvedValue(undefined);
  m.espejarSinFallar.mockResolvedValue(undefined);
  m.enControl.mockImplementation(async (ctx: { tenantId: string }, armar: (db: unknown) => unknown) => {
    expect(ctx).toEqual({ tenantId: TENANT_ID });
    const consulta: (typeof m.consultas)[number] = { tipo: "" };
    m.consultas.push(consulta);
    const filas = m.respuestas.shift() ?? [];
    const cadena = {
      update: () => ((consulta.tipo = "update"), cadena),
      select: () => ((consulta.tipo = "select"), cadena),
      set: (v: Record<string, unknown>) => ((consulta.set = v), cadena),
      from: () => cadena,
      where: (w: unknown) => ((consulta.where = w), cadena),
      returning: () => Promise.resolve(filas),
      limit: () => Promise.resolve(filas),
    };
    return armar(cadena);
  });
});

const nadaCambio = () => {
  expect(m.cerrarSesiones).not.toHaveBeenCalled();
  expect(m.olvidarFilaDeUsuario).not.toHaveBeenCalled();
  expect(m.writeAuditLog).not.toHaveBeenCalled();
};

describe("quién da de baja y a quién", () => {
  it("sin rol de admin no llega a la base", async () => {
    m.requireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    expect((await darDeBaja(OBJETIVO_ID)).status).toBe(403);
    expect(m.enControl).not.toHaveBeenCalled();
    nadaCambio();
  });

  it("un id que no es uuid es un 404 sin consultar", async () => {
    expect((await darDeBaja("no-es-un-uuid")).status).toBe(404);
    expect(m.enControl).not.toHaveBeenCalled();
  });

  it("uno mismo es un 400 sin tocar nada: el último admin no se puede ir", async () => {
    const res = await darDeBaja(ADMIN_ID);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("No podés darte de baja a vos mismo.");
    expect(m.enControl).not.toHaveBeenCalled();
    nadaCambio();
  });

  it("alguien de otro inquilino (o que no existe) es un 404 y no se cierra nada", async () => {
    m.respuestas = [[], []];

    expect((await darDeBaja(OBJETIVO_ID)).status).toBe(404);
    expect(m.consultas.map((c) => c.tipo)).toEqual(["update", "select"]);
    nadaCambio();
  });

  it("un admin contra un owner es un 403: la regla viaja en el WHERE de la baja", async () => {
    m.respuestas = [[], [{ id: OBJETIVO_ID }]];

    const res = await darDeBaja(OBJETIVO_ID);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN_ROLE");
    const { sql, params } = enSql(m.consultas[0]!.where);
    expect(sql).toContain('"users"."role" <> $');
    expect(params).toContain("owner");
    nadaCambio();
  });

  it("un owner sí puede con otro owner", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));

    expect((await darDeBaja(OBJETIVO_ID)).status).toBe(200);
    expect(enSql(m.consultas[0]!.where).sql).not.toContain('"role"');
    expect(m.cerrarSesiones).toHaveBeenCalledWith(OBJETIVO_ID);
  });
});

describe("lo que hace la baja", () => {
  it("marca la baja, después cierra las sesiones, olvida la fila y audita con cuántas cerró", async () => {
    const res = await darDeBaja(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: FILA, sesiones_cerradas: 2 });

    expect(m.consultas).toHaveLength(1);
    expect(m.consultas[0]!.tipo).toBe("update");
    const fecha = new PgDialect().sqlToQuery(m.consultas[0]!.set!.dado_de_baja_en as SQL).sql;
    expect(fecha).toBe('coalesce("users"."dado_de_baja_en", now())');

    expect(m.enControl.mock.invocationCallOrder[0]).toBeLessThan(m.cerrarSesiones.mock.invocationCallOrder[0]!);
    expect(m.cerrarSesiones).toHaveBeenCalledWith(OBJETIVO_ID);
    expect(m.olvidarFilaDeUsuario).toHaveBeenCalledWith(OBJETIVO_ID);
    expect(m.espejarSinFallar).toHaveBeenCalledWith(TENANT_ID);
    expect(m.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(m.writeAuditLog).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      actor_id: ADMIN_ID,
      event_type: "auth.user_deactivated",
      target_type: "user",
      target_id: OBJETIVO_ID,
      payload: { sesiones_cerradas: 2 },
    });
  });

  it("si cerrar las sesiones falla es un 500 sin auditoría, y la baja ya quedó marcada", async () => {
    m.cerrarSesiones.mockRejectedValue(new Error("conexión caída"));

    expect((await darDeBaja(OBJETIVO_ID)).status).toBe(500);
    expect(m.consultas.map((c) => c.tipo)).toEqual(["update"]);
    expect(m.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("volver a habilitar", () => {
  it("PATCH { activo: true } borra la marca, olvida la fila y audita", async () => {
    m.respuestas = [[{ ...FILA, dado_de_baja_en: null }]];

    const res = await habilitar(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect((await res.json()).user.dado_de_baja_en).toBeNull();
    expect(m.consultas[0]!.set).toEqual({ dado_de_baja_en: null });
    expect(m.cerrarSesiones).not.toHaveBeenCalled();
    expect(m.olvidarFilaDeUsuario).toHaveBeenCalledWith(OBJETIVO_ID);
    expect(m.writeAuditLog).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      actor_id: ADMIN_ID,
      event_type: "auth.user_reactivated",
      target_type: "user",
      target_id: OBJETIVO_ID,
    });
  });

  it("un admin no habilita a un owner", async () => {
    m.respuestas = [[], [{ id: OBJETIVO_ID }]];

    expect((await habilitar(OBJETIVO_ID)).status).toBe(403);
    nadaCambio();
  });

  it("uno mismo tampoco: es un 400 sin consultar", async () => {
    expect((await habilitar(ADMIN_ID)).status).toBe(400);
    expect(m.enControl).not.toHaveBeenCalled();
  });
});
