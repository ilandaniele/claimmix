/**
 * DELETE /api/admin/users/:id: un admin da de baja a otra persona de su
 * inquilino, y PATCH { activo: true } la vuelve a habilitar; PATCH { role } le
 * cambia el rol. Las tres cosas son un solo lote con el candado del espacio
 * primero, y la regla mira a quien pide en la base, no en la caché: uno no se da
 * de baja a sí mismo, sólo un owner toca a un owner (así al espacio siempre le
 * queda quien lo administre), un admin dado de baja o degradado hace segundos no
 * cambia a nadie, una persona de otro inquilino no existe, y la baja se marca
 * antes de cerrar las sesiones, olvida la fila cacheada y queda auditada.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { AppError } from "@/lib/errors";

type Sentencia = { tipo: string; sql: string; params: unknown[] };

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  enControlVarias: vi.fn(),
  cerrarSesiones: vi.fn(),
  writeAuditLog: vi.fn(),
  espejarSinFallar: vi.fn(),
  olvidarFilaDeUsuario: vi.fn(),
  /** Lo que devuelve cada lote: una tupla [candado, lectura, escritura] por llamada. */
  respuestas: [] as unknown[][][],
  /** Las sentencias de cada lote, en el orden en que viajan. */
  lotes: [] as Sentencia[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/auth/sesiones", () => ({ cerrarSesiones: m.cerrarSesiones }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ olvidarFilaDeUsuario: m.olvidarFilaDeUsuario }));
vi.mock("@/server/bases/espejar-sin-fallar", () => ({ espejarSinFallar: m.espejarSinFallar }));
vi.mock("@/data/scope", () => ({ enControlVarias: m.enControlVarias }));
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
const HABILITADA = { ...FILA, dado_de_baja_en: null };

const MSG_BAJA_OWNER = "Solo un owner puede dar de baja o habilitar a un owner.";
const MSG_ROL_OWNER = "Solo un owner puede asignar o modificar el rol owner.";
const MSG_SIN_PERMISO = "No tenés permisos para realizar esta acción.";

const comoAdmin = (role: string) => ({
  user: { id: ADMIN_ID },
  userRow: { id: ADMIN_ID, tenant_id: TENANT_ID, role },
});

const contexto = (id: string) => ({ params: Promise.resolve({ id }) });
const darDeBaja = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/admin/users/${id}`, { method: "DELETE" }), contexto(id));
const patch = (id: string, cuerpo: object) =>
  PATCH(
    new NextRequest(`http://localhost/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(cuerpo) }),
    contexto(id)
  );
const habilitar = (id: string) => patch(id, { activo: true });
const cambiarRol = (id: string, role: string) => patch(id, { role });

/** Las tres operaciones, para probar lo que comparten. */
const OPERACIONES = [
  { nombre: "la baja", ejecutar: () => darDeBaja(OBJETIVO_ID), fila: FILA, rolNuevo: null, mensajeOwner: MSG_BAJA_OWNER },
  { nombre: "el alta", ejecutar: () => habilitar(OBJETIVO_ID), fila: HABILITADA, rolNuevo: null, mensajeOwner: MSG_BAJA_OWNER },
  { nombre: "el cambio de rol", ejecutar: () => cambiarRol(OBJETIVO_ID, "analyst"), fila: FILA, rolNuevo: "analyst", mensajeOwner: MSG_ROL_OWNER },
] as const;

const TIPOS: Record<string, string> = { PgRaw: "execute", PgSelectBase: "select", PgUpdateBase: "update" };

const base = drizzle(async () => ({ rows: [] }));
const dialecto = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
  m.respuestas = [[[], [{ role: "analyst" }], [FILA]]];
  m.lotes = [];
  m.requireAdmin.mockResolvedValue(comoAdmin("admin"));
  m.cerrarSesiones.mockResolvedValue(2);
  m.writeAuditLog.mockResolvedValue(undefined);
  m.espejarSinFallar.mockResolvedValue(undefined);
  m.enControlVarias.mockImplementation(async (ctx: { tenantId: string }, armar: (db: unknown) => Array<{ getSQL(): SQL }>) => {
    expect(ctx).toEqual({ tenantId: TENANT_ID });
    m.lotes.push(
      armar(base).map((q) => ({
        tipo: TIPOS[q.constructor.name] ?? q.constructor.name,
        ...dialecto.sqlToQuery(q.getSQL()),
      }))
    );
    return m.respuestas.shift() ?? [[], [], []];
  });
});

const nadaCambio = () => {
  expect(m.cerrarSesiones).not.toHaveBeenCalled();
  expect(m.olvidarFilaDeUsuario).not.toHaveBeenCalled();
  expect(m.espejarSinFallar).not.toHaveBeenCalled();
  expect(m.writeAuditLog).not.toHaveBeenCalled();
};

describe("quién da de baja y a quién", () => {
  it("sin rol de admin no llega a la base", async () => {
    m.requireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    expect((await darDeBaja(OBJETIVO_ID)).status).toBe(403);
    expect(m.enControlVarias).not.toHaveBeenCalled();
    nadaCambio();
  });

  it("un id que no es uuid es un 404 sin consultar", async () => {
    expect((await darDeBaja("no-es-un-uuid")).status).toBe(404);
    expect(m.enControlVarias).not.toHaveBeenCalled();
  });

  it("uno mismo es un 400 sin tocar nada: el último admin no se puede ir", async () => {
    const res = await darDeBaja(ADMIN_ID);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("No podés darte de baja a vos mismo.");
    expect(m.enControlVarias).not.toHaveBeenCalled();
    nadaCambio();
  });

  it("alguien de otro inquilino (o que no existe) es un 404 en un solo lote, sin segunda lectura", async () => {
    m.respuestas = [[[], [], []]];

    expect((await darDeBaja(OBJETIVO_ID)).status).toBe(404);
    expect(m.enControlVarias).toHaveBeenCalledTimes(1);
    nadaCambio();
  });

  it.each(OPERACIONES)("$nombre: un admin contra un owner es un 403 con el mensaje del owner", async (op) => {
    m.respuestas = [[[], [{ role: "owner", actor: "admin" }], []]];

    const res = await op.ejecutar();

    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error.code).toBe("FORBIDDEN_ROLE");
    expect(error.message).toBe(op.mensajeOwner);
    expect(m.enControlVarias).toHaveBeenCalledTimes(1);
    nadaCambio();
  });

  it("un admin que le asigna owner a un analista es un 403 con el mensaje del rol owner", async () => {
    m.respuestas = [[[], [{ role: "analyst", actor: "admin" }], []]];

    const res = await cambiarRol(OBJETIVO_ID, "owner");

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe(MSG_ROL_OWNER);
    nadaCambio();
  });

  it("un owner sí puede con otro owner", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));
    m.respuestas = [[[], [{ role: "owner" }], [{ ...FILA, role: "owner" }]]];

    expect((await darDeBaja(OBJETIVO_ID)).status).toBe(200);
    expect(m.cerrarSesiones).toHaveBeenCalledWith(OBJETIVO_ID);
  });
});

describe("baja, alta y rol son una sola ida, candado primero", () => {
  it.each(OPERACIONES)("$nombre: tres sentencias en una invocación, el candado del espacio antes que todo", async (op) => {
    m.respuestas = [[[], [{ role: "analyst" }], [op.fila]]];

    expect((await op.ejecutar()).status).toBe(200);

    expect(m.enControlVarias).toHaveBeenCalledTimes(1);
    expect(m.lotes).toHaveLength(1);
    expect(m.lotes[0]!.map((s) => s.tipo)).toEqual(["execute", "select", "update"]);
    const candado = m.lotes[0]![0]!;
    expect(candado.sql).toContain("pg_advisory_xact_lock(hashtext('admins'), hashtext(");
    expect(candado.params).toEqual([TENANT_ID]);
  });

  it("la baja se marca antes de cerrar las sesiones", async () => {
    await darDeBaja(OBJETIVO_ID);

    expect(m.enControlVarias.mock.invocationCallOrder[0]).toBeLessThan(m.cerrarSesiones.mock.invocationCallOrder[0]!);
  });
});

describe("la caché no decide", () => {
  it.each(OPERACIONES)("$nombre: el mismo lote con la caché de owner que con la de admin", async (op) => {
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));
    m.respuestas = [[[], [{ role: "analyst" }], [op.fila]]];
    await op.ejecutar();

    m.requireAdmin.mockResolvedValue(comoAdmin("admin"));
    m.respuestas = [[[], [{ role: "analyst" }], [op.fila]]];
    await op.ejecutar();

    expect(m.lotes).toHaveLength(2);
    expect(m.lotes[0]).toEqual(m.lotes[1]);
  });
});

describe("el guard lee a quien pide en la base", () => {
  it.each(OPERACIONES)("$nombre: el WHERE del UPDATE busca al actor, vivo, y la regla del owner", async (op) => {
    m.respuestas = [[[], [{ role: "analyst" }], [op.fila]]];

    await op.ejecutar();

    const update = m.lotes[0]![2]!;
    expect(update.sql).toContain("from public.users a");
    expect(update.sql).toContain("a.id = $");
    expect(update.sql).toContain("a.dado_de_baja_en is null");
    expect(update.sql).toContain("a.role = 'owner'");
    expect(update.sql).toContain("a.role = 'admin'");
    expect(update.sql).toContain('"users"."role" <> \'owner\'');
    expect(update.sql).toContain("is distinct from 'owner'");
    expect(update.params).toContain(ADMIN_ID);
    expect(update.params).toContain(OBJETIVO_ID);
  });

  it("en el cambio de rol, el rol nuevo viaja como parámetro del guard", async () => {
    m.respuestas = [[[], [{ role: "analyst" }], [{ ...FILA, role: "owner" }]]];
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));
    await cambiarRol(OBJETIVO_ID, "owner");

    m.respuestas = [[[], [{ role: "viewer" }], [FILA]]];
    await cambiarRol(OBJETIVO_ID, "analyst");

    // Una en el SET y otra en el guard.
    expect(m.lotes[0]![2]!.params.filter((p) => p === "owner")).toHaveLength(2);
    expect(m.lotes[1]![2]!.params.filter((p) => p === "analyst")).toHaveLength(2);
  });

  it("en la baja y el alta no hay rol nuevo: el guard recibe null", async () => {
    await darDeBaja(OBJETIVO_ID);
    m.respuestas = [[[], [{ role: "analyst" }], [HABILITADA]]];
    await habilitar(OBJETIVO_ID);

    expect(m.lotes[0]![2]!.params).toContain(null);
    expect(m.lotes[1]![2]!.params).toContain(null);
  });
});

describe("actor dado de baja o degradado", () => {
  it.each(OPERACIONES)("$nombre: con la caché vieja de owner, la base no deja pasar y es un 403 sin mensaje de owner", async (op) => {
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));
    m.respuestas = [[[], [{ role: "analyst" }], []]];

    const res = await op.ejecutar();

    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error.code).toBe("FORBIDDEN_ROLE");
    expect(error.message).toBe(MSG_SIN_PERMISO);
    nadaCambio();
  });

  it.each(OPERACIONES)("$nombre: el actor que ya no es admin ve el 403 sin mensaje de owner aunque el objetivo sea owner", async (op) => {
    for (const actor of [null, "analyst"]) {
      m.respuestas = [[[], [{ role: "owner", actor }], []]];

      const res = await op.ejecutar();

      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toBe(MSG_SIN_PERMISO);
    }
    nadaCambio();
  });

  it("el rol del actor sale del mismo SELECT del lote, vivo, sin sentencias de más", async () => {
    await darDeBaja(OBJETIVO_ID);

    const [candado, lectura, escritura] = m.lotes[0]!;
    expect(m.lotes[0]).toHaveLength(3);
    expect(candado!.tipo).toBe("execute");
    expect(lectura!.tipo).toBe("select");
    expect(escritura!.tipo).toBe("update");
    expect(lectura!.sql).toContain("from public.users a");
    expect(lectura!.sql).toContain("a.dado_de_baja_en is null");
    expect(lectura!.params).toContain(ADMIN_ID);
  });

  it("el SELECT y el guard del UPDATE definen al actor vivo con el mismo texto", async () => {
    await darDeBaja(OBJETIVO_ID);

    const [, lectura, escritura] = m.lotes[0]!;
    const sinNumerar = (texto: string) => texto.replace(/\$\d+/g, "$");
    const actorVivo = "from public.users a where a.id = $::uuid and a.dado_de_baja_en is null";
    expect(sinNumerar(lectura!.sql)).toContain(actorVivo);
    expect(sinNumerar(escritura!.sql)).toContain(actorVivo);
  });

  it("un actor dado de baja que habilita a otro es un 403, sin auditoría ni espejo", async () => {
    m.respuestas = [[[], [{ role: "analyst" }], []]];

    expect((await habilitar(OBJETIVO_ID)).status).toBe(403);
    nadaCambio();
  });
});

describe("lo que hace la baja", () => {
  it("marca la baja, después cierra las sesiones, olvida la fila y audita con cuántas cerró", async () => {
    const res = await darDeBaja(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: FILA, sesiones_cerradas: 2 });

    expect(m.lotes).toHaveLength(1);
    const update = m.lotes[0]![2]!;
    // coalesce: repetir la baja no le cambia la fecha.
    expect(update.sql).toContain('set "dado_de_baja_en" = coalesce("users"."dado_de_baja_en", now())');

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
    expect(m.lotes[0]!.map((s) => s.tipo)).toEqual(["execute", "select", "update"]);
    expect(m.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("volver a habilitar", () => {
  it("PATCH { activo: true } borra la marca, olvida la fila y audita", async () => {
    m.respuestas = [[[], [{ role: "analyst" }], [HABILITADA]]];

    const res = await habilitar(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect((await res.json()).user.dado_de_baja_en).toBeNull();
    expect(m.lotes[0]![2]!.sql).toContain('set "dado_de_baja_en" = $');
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

  it("uno mismo tampoco: es un 400 sin consultar", async () => {
    expect((await habilitar(ADMIN_ID)).status).toBe(400);
    expect(m.enControlVarias).not.toHaveBeenCalled();
  });
});

describe("cambiar el rol", () => {
  it("PATCH role audita el rol de antes, el que leyó el mismo lote", async () => {
    m.respuestas = [[[], [{ role: "viewer" }], [FILA]]];

    const res = await cambiarRol(OBJETIVO_ID, "analyst");

    expect(res.status).toBe(200);
    expect(m.enControlVarias).toHaveBeenCalledTimes(1);
    expect(m.espejarSinFallar).toHaveBeenCalledWith(TENANT_ID);
    expect(m.olvidarFilaDeUsuario).toHaveBeenCalledWith(OBJETIVO_ID);
    expect(m.writeAuditLog).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      actor_id: ADMIN_ID,
      event_type: "auth.user_role_changed",
      target_type: "user",
      target_id: OBJETIVO_ID,
      payload: { previous_role: "viewer", role: "analyst" },
    });
  });

  it("uno mismo es un 400 sin consultar", async () => {
    expect((await cambiarRol(ADMIN_ID, "viewer")).status).toBe(400);
    expect(m.enControlVarias).not.toHaveBeenCalled();
  });
});
