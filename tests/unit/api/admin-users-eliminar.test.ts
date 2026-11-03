/**
 * DELETE /api/admin/users/:id/cuenta: un admin borra a una persona de su espacio
 * que ya estaba dada de baja (su perfil y su cuenta de Better Auth).
 *
 * Toda la regla vive en el WHERE del DELETE, dentro del lote con el candado de
 * admins primero: sólo quien ya estaba dado de baja, sólo de ese inquilino, nunca
 * uno mismo, sólo un owner borra a un owner, y quien pide tiene que ser admin u
 * owner vivo en la base. Así el espacio siempre conserva a quien lo administre
 * (no se borra a nadie que esté activo, y el actor queda). La lectura previa del
 * lote sólo elige el mensaje de error. El historial no se toca: las claves
 * foráneas son SET NULL (ver fk-usuarios-on-delete.test.ts), salvo que la persona
 * tenga casos asignados (ese SET NULL reiniciaría los relojes del caso) o algo
 * firmado en un caso (quedaría sin autor y pasaría por trabajo del agente): el
 * borrado espera. El asiento `auth.user_deleted` sale de la misma sentencia.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AppError } from "@/lib/errors";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { VIGENTE } from "@/server/sso/config";

type Sentencia = { sql: string; params: unknown[] };

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  batch: vi.fn(),
  casoQueRetiene: vi.fn(),
  espejarSinFallar: vi.fn(),
  olvidarFilaDeUsuario: vi.fn(),
  /** Lo que devuelve cada lote: [candado, lectura previa, delete]. */
  respuestas: [] as unknown[][],
  /** Las sentencias de cada lote, en el orden en que viajan. */
  lotes: [] as Sentencia[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ olvidarFilaDeUsuario: m.olvidarFilaDeUsuario }));
vi.mock("@/server/bases/espejar-sin-fallar", () => ({ espejarSinFallar: m.espejarSinFallar }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn(), enControl: vi.fn() }));
// El idioma de la cuenta, sin leer la cookie.
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: async (l?: string | null) => l ?? "es-AR" }));
vi.mock("@/lib/db", () => ({ db: { execute: (q: SQL) => q, batch: m.batch } }));
// Los casos viven en la base del cliente: el borrado de control los mira antes, por aparte.
vi.mock("@/server/cases/asignados-a", () => ({ casoQueRetiene: m.casoQueRetiene }));

import { DELETE } from "@/app/api/admin/users/[id]/cuenta/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const ADMIN_ID = "20000000-0000-0000-0000-000000000001";
const OBJETIVO_ID = "30000000-0000-0000-0000-000000000001";

const comoAdmin = (role: string, locale?: string) => ({
  user: { id: ADMIN_ID },
  userRow: { id: ADMIN_ID, tenant_id: TENANT_ID, role, locale },
});

const contexto = (id: string) => ({ params: Promise.resolve({ id }) });
const eliminar = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/admin/users/${id}/cuenta`, { method: "DELETE" }), contexto(id));

const dialecto = new PgDialect();
const BORRADA = { id: OBJETIVO_ID, role: "analyst" };
/** La lectura previa de una persona dada de baja que un admin vivo puede borrar. */
const PREVIA = { role: "analyst", de_baja: true, actor_rol: "admin", sso: false, operador: false };

/** Lo que el lote contesta: el candado, la lectura previa y el DELETE. */
const lote = (previa: object | null, borrada: object | null = null) => [[], previa ? [previa] : [], borrada ? [borrada] : []];

const nadaCambio = () => {
  expect(m.olvidarFilaDeUsuario).not.toHaveBeenCalled();
  expect(m.espejarSinFallar).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ADMIN_EMAILS;
  m.respuestas = [lote(PREVIA, BORRADA)];
  m.lotes = [];
  m.requireAdmin.mockResolvedValue(comoAdmin("admin"));
  m.casoQueRetiene.mockResolvedValue(null);
  m.espejarSinFallar.mockResolvedValue(undefined);
  m.batch.mockImplementation(async (consultas: SQL[]) => {
    m.lotes.push(consultas.map((q) => dialecto.sqlToQuery(q)));
    return m.respuestas.shift() ?? lote(null);
  });
});

afterEach(() => {
  delete process.env.ADMIN_EMAILS;
});

describe("quién borra y a quién", () => {
  it("sin rol de admin no llega a la base", async () => {
    m.requireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    expect((await eliminar(OBJETIVO_ID)).status).toBe(403);
    expect(m.batch).not.toHaveBeenCalled();
    nadaCambio();
  });

  it("un id que no es uuid es un 404 sin consultar", async () => {
    expect((await eliminar("no-es-un-uuid")).status).toBe(404);
    expect(m.batch).not.toHaveBeenCalled();
  });

  it("uno mismo es un 400 sin tocar la base", async () => {
    const res = await eliminar(ADMIN_ID);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.eliminar.propio"]);
    expect(m.batch).not.toHaveBeenCalled();
    nadaCambio();
  });

  it("alguien de otro inquilino (o que no existe) es un 404 en un solo lote", async () => {
    m.respuestas = [lote(null)];

    expect((await eliminar(OBJETIVO_ID)).status).toBe(404);
    expect(m.batch).toHaveBeenCalledTimes(1);
    nadaCambio();
  });

  it("quien pidió ya no es admin vivo (dado de baja o degradado): 403 aunque la caché diga que sí", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));
    for (const actor_rol of [null, undefined]) {
      m.respuestas = [lote({ ...PREVIA, actor_rol })];

      const res = await eliminar(OBJETIVO_ID);

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN_ROLE");
    }
    nadaCambio();
  });

  it("un admin no borra a un owner: 403 con el mensaje del owner", async () => {
    m.respuestas = [lote({ ...PREVIA, role: "owner", actor_rol: "admin" })];

    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.eliminar.owner"]);
    nadaCambio();
  });

  it("un owner sí borra a otro owner", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("owner"));
    m.respuestas = [lote({ ...PREVIA, role: "owner", actor_rol: "owner" }, { ...BORRADA, role: "owner" })];

    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect(m.olvidarFilaDeUsuario).toHaveBeenCalledWith(OBJETIVO_ID);
  });
});

describe("sólo se borra a quien ya estaba dado de baja", () => {
  it("una persona activa es un 409 y no se borra ni se audita nada", async () => {
    m.respuestas = [lote({ ...PREVIA, de_baja: false })];

    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe(esARServidor["usuarios.eliminar.activo"]);
    nadaCambio();
  });

  it("el WHERE del DELETE exige la marca de baja: la regla no depende de la lectura previa", async () => {
    await eliminar(OBJETIVO_ID);

    const borrado = m.lotes[0]![2]!;
    expect(borrado.sql).toContain('delete from public."user" u');
    expect(borrado.sql).toContain("t.dado_de_baja_en is not null");
  });

  it("el mensaje sale en el idioma de la cuenta", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("admin", "en-US"));
    m.respuestas = [lote({ ...PREVIA, de_baja: false })];

    expect((await (await eliminar(OBJETIVO_ID)).json()).error.message).toBe(enUSServidor["usuarios.eliminar.activo"]);
  });
});

describe("la regla vive en el DELETE, con el inquilino a mano", () => {
  it("el DELETE filtra por inquilino, por la persona, que no sea quien pide y que quien pide siga vivo", async () => {
    await eliminar(OBJETIVO_ID);

    const borrado = m.lotes[0]![2]!;
    expect(borrado.sql).toContain("t.id = $");
    expect(borrado.sql).toContain("t.tenant_id = $");
    expect(borrado.sql).toContain("t.id <> $");
    expect(borrado.sql).toContain("from public.users a");
    expect(borrado.sql).toContain("a.tenant_id = $");
    expect(borrado.sql).toContain("a.dado_de_baja_en is null");
    expect(borrado.sql).toContain("a.role in ('owner', 'admin')");
    expect(borrado.params).toContain(TENANT_ID);
    expect(borrado.params).toContain(OBJETIVO_ID);
    expect(borrado.params).toContain(ADMIN_ID);
  });

  it("sólo un owner vivo borra a un owner, también en el DELETE", async () => {
    await eliminar(OBJETIVO_ID);

    expect(m.lotes[0]![2]!.sql).toContain("(t.role <> 'owner' or exists (select 1 from public.users a");
    expect(m.lotes[0]![2]!.sql).toContain("a.role = 'owner'");
  });

  it("la lectura previa también va con el inquilino a mano, y el DELETE devuelve el rol y la dirección para el asiento", async () => {
    await eliminar(OBJETIVO_ID);

    const previa = m.lotes[0]![1]!;
    expect(previa.sql).toContain("t.tenant_id = $");
    expect(previa.params).toContain(TENANT_ID);
    expect(m.lotes[0]![2]!.sql).toContain("returning u.id, u.email, t.role");
  });

  it("el SELECT previo y el DELETE definen al actor vivo con el mismo texto", async () => {
    await eliminar(OBJETIVO_ID);

    const [, previa, borrado] = m.lotes[0]!;
    const sinNumerar = (texto: string) => texto.replace(/\$\d+/g, "$");
    const actorVivo =
      "public.users a where a.id = $::uuid and a.tenant_id = $::uuid and a.dado_de_baja_en is null and a.role in ('owner', 'admin')";
    expect(sinNumerar(previa!.sql)).toContain(actorVivo);
    expect(sinNumerar(borrado!.sql)).toContain(actorVivo);
  });

  it("al último admin no se lo lleva el borrado: sólo se borra a alguien dado de baja y quien pide, vivo y distinto, queda", async () => {
    await eliminar(OBJETIVO_ID);

    const { sql } = m.lotes[0]![2]!;
    expect(sql).toContain("t.dado_de_baja_en is not null");
    expect(sql).toContain("t.id <> $");
    expect(sql).toContain("exists (select 1 from public.users a");
  });
});

describe("un solo lote, con el candado de admins primero", () => {
  it("tres sentencias en una invocación: candado, lectura y DELETE", async () => {
    expect((await eliminar(OBJETIVO_ID)).status).toBe(200);

    expect(m.batch).toHaveBeenCalledTimes(1);
    expect(m.lotes).toHaveLength(1);
    expect(m.lotes[0]).toHaveLength(3);
    const candado = m.lotes[0]![0]!;
    expect(candado.sql).toContain("pg_advisory_xact_lock(hashtext('admins'), hashtext(");
    expect(candado.params).toEqual([TENANT_ID]);
    expect(m.lotes[0]![1]!.sql).toMatch(/^\s*select/);
    expect(m.lotes[0]![2]!.sql).toMatch(/^\s*with borrado as \(\s*delete/);
  });
});

describe("a quien se volvería a crear solo no se lo borra", () => {
  it("entra por el SSO vigente de la empresa: 409, y el DELETE lo deja afuera", async () => {
    m.respuestas = [lote({ ...PREVIA, sso: true })];

    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.eliminar.sso"]);
    nadaCambio();
  });

  it("es de operación (ADMIN_EMAILS): 409", async () => {
    m.respuestas = [lote({ ...PREVIA, operador: true })];

    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.eliminar.operador"]);
    nadaCambio();
  });

  // La condición es la de `src/server/sso/config.ts`, no una copia a mano: si esa cambia, esta cambia con ella.
  it("el DELETE usa la misma condición de SSO vigente que el ingreso, no una copia", async () => {
    await eliminar(OBJETIVO_ID);

    const sinNumerar = (texto: string) => texto.replace(/\$\d+/g, "$");
    const vigente = sinNumerar(dialecto.sqlToQuery(VIGENTE as SQL).sql);
    const { sql } = m.lotes[0]![2]!;
    expect(sql).toContain("not exists (select 1 from public.sso_settings where");
    expect(sinNumerar(sql)).toContain(vigente);
    expect(vigente).toContain('"sso_settings"."activo" = $');
    expect(vigente).toContain('"sso_settings"."client_secret_cifrado" is not null');
    expect(sql).toContain('"sso_settings"."tenant_id" = $');
  });

  it("el DELETE compara la dirección con ADMIN_EMAILS normalizadas, una por parámetro", async () => {
    process.env.ADMIN_EMAILS = " Ops@Example.com , otra@example.com ";
    await eliminar(OBJETIVO_ID);

    const { sql, params } = m.lotes[0]![2]!;
    expect(sql).toMatch(/not lower\(u\.email\) in \(\$\d+, \$\d+\)/);
    expect(params).toContain("ops@example.com");
    expect(params).toContain("otra@example.com");
    expect(sql).not.toContain("jsonb_array_elements_text");
  });

  it("sin ADMIN_EMAILS no rompe: ninguna dirección es de operación", async () => {
    await eliminar(OBJETIVO_ID);

    expect(m.lotes[0]![2]!.sql).toContain("and not false");
  });
});

describe("con casos atados no se borra: el SET NULL cambiaría lo que los casos ven", () => {
  it("mira los casos de la persona en el espacio del admin, antes del lote", async () => {
    await eliminar(OBJETIVO_ID);

    expect(m.casoQueRetiene).toHaveBeenCalledWith(TENANT_ID, OBJETIVO_ID);
    expect(m.casoQueRetiene.mock.invocationCallOrder[0]).toBeLessThan(m.batch.mock.invocationCallOrder[0]!);
  });

  it("el DELETE lleva el resultado como condición: no se borra aunque la lectura previa diga que sí", async () => {
    m.casoQueRetiene.mockResolvedValue("asignados");
    m.respuestas = [lote(PREVIA, null)];

    const res = await eliminar(OBJETIVO_ID);

    const { sql, params } = m.lotes[0]![2]!;
    expect(sql).toMatch(/and not \$\d+::boolean/);
    expect(params).toContain(true);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.eliminar.casos"]);
    nadaCambio();
  });

  it("sin casos el parámetro es false", async () => {
    await eliminar(OBJETIVO_ID);

    expect(m.lotes[0]![2]!.params).toContain(false);
  });

  it("con algo firmado en un caso tampoco se borra, y el mensaje dice que queda dada de baja", async () => {
    m.casoQueRetiene.mockResolvedValue("firmo");
    m.respuestas = [lote(PREVIA, null)];

    const res = await eliminar(OBJETIVO_ID);

    expect(m.lotes[0]![2]!.params).toContain(true);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.eliminar.firmo"]);
    nadaCambio();
  });

  it("el mensaje de lo firmado sale en el idioma de la cuenta", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("admin", "en-US"));
    m.casoQueRetiene.mockResolvedValue("firmo");
    m.respuestas = [lote(PREVIA, null)];

    expect((await (await eliminar(OBJETIVO_ID)).json()).error.message).toBe(enUSServidor["usuarios.eliminar.firmo"]);
  });

  it("a una persona activa que además firmó casos se le dice que antes hay que darla de baja", async () => {
    m.casoQueRetiene.mockResolvedValue("firmo");
    m.respuestas = [lote({ ...PREVIA, de_baja: false })];

    expect((await (await eliminar(OBJETIVO_ID)).json()).error.message).toBe(esARServidor["usuarios.eliminar.activo"]);
  });

  it("a una persona activa se le dice que antes hay que darla de baja, no que tiene casos", async () => {
    m.casoQueRetiene.mockResolvedValue("asignados");
    m.respuestas = [lote({ ...PREVIA, de_baja: false })];

    expect((await (await eliminar(OBJETIVO_ID)).json()).error.message).toBe(esARServidor["usuarios.eliminar.activo"]);
  });

  it("el mensaje sale en el idioma de la cuenta", async () => {
    m.requireAdmin.mockResolvedValue(comoAdmin("admin", "en-US"));
    m.casoQueRetiene.mockResolvedValue("asignados");
    m.respuestas = [lote(PREVIA, null)];

    expect((await (await eliminar(OBJETIVO_ID)).json()).error.message).toBe(enUSServidor["usuarios.eliminar.casos"]);
  });
});

describe("si una referencia lo frena, no se fuerza nada", () => {
  it("un 23503 es un 409 sin reintento, sin espejo y sin auditoría", async () => {
    m.batch.mockRejectedValue(Object.assign(new Error("update or delete on table violates foreign key"), { code: "23503" }));

    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.eliminar.referencias"]);
    expect(m.batch).toHaveBeenCalledTimes(1);
    nadaCambio();
  });

  it("el 23503 que viene en `cause` también", async () => {
    m.batch.mockRejectedValue(Object.assign(new Error("falló"), { cause: { code: "23503" } }));

    expect((await eliminar(OBJETIVO_ID)).status).toBe(409);
    nadaCambio();
  });

  it("cualquier otra falla de la base es un 500 sin detalle, sin espejo y sin auditoría", async () => {
    m.batch.mockRejectedValue(Object.assign(new Error("conexión caída: host secreto"), { code: "57P01" }));

    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("host secreto");
    nadaCambio();
  });
});

describe("lo que hace el borrado", () => {
  it("contesta con la persona borrada", async () => {
    const res = await eliminar(OBJETIVO_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eliminado: OBJETIVO_ID });
  });

  it("olvida la fila cacheada y vuelve a espejar el espacio, en ese orden y después del lote", async () => {
    await eliminar(OBJETIVO_ID);

    expect(m.olvidarFilaDeUsuario).toHaveBeenCalledWith(OBJETIVO_ID);
    expect(m.espejarSinFallar).toHaveBeenCalledWith(TENANT_ID);
    expect(m.batch.mock.invocationCallOrder[0]).toBeLessThan(m.olvidarFilaDeUsuario.mock.invocationCallOrder[0]!);
    expect(m.olvidarFilaDeUsuario.mock.invocationCallOrder[0]).toBeLessThan(m.espejarSinFallar.mock.invocationCallOrder[0]!);
  });

  // El asiento viaja en el mismo lote: no hay borrado sin asiento, y el registro de control
  // es el que mira `aceptarInvitacion` para revocar los enlaces emitidos antes.
  it("asienta auth.user_deleted en la misma sentencia del borrado, con el rol y la huella", async () => {
    await eliminar(OBJETIVO_ID);

    const { sql, params } = m.lotes[0]![2]!;
    expect(m.batch).toHaveBeenCalledTimes(1);
    expect(sql).toContain("insert into public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload)");
    expect(sql).toContain("from borrado b");
    expect(sql).toContain("jsonb_build_object('rol', b.role, 'huella', encode(sha256(convert_to(");
    expect(sql).toContain("lower(btrim(b.email))");
    expect(params).toContain("auth.user_deleted");
    expect(params).toContain(ADMIN_ID);
  });

  it("el asiento no lleva el correo ni el nombre: sólo la huella, calculada por la base", async () => {
    process.env.ADMIN_EMAILS = "ops@example.com";
    await eliminar(OBJETIVO_ID);

    const { sql, params } = m.lotes[0]![2]!;
    expect(sql).not.toContain("full_name");
    expect(params.filter((p) => typeof p === "string" && p.includes("@"))).toEqual(["ops@example.com"]);
  });

  it("no escribe ningún asiento por fuera del lote: si el lote falla, no queda asiento", async () => {
    m.batch.mockRejectedValue(Object.assign(new Error("falló"), { code: "57P01" }));

    expect((await eliminar(OBJETIVO_ID)).status).toBe(500);
    expect(m.batch).toHaveBeenCalledTimes(1);
    nadaCambio();
  });

  it("si el DELETE no borró nada y no hay motivo claro, es un 403 y no se audita", async () => {
    m.respuestas = [lote(PREVIA, null)];

    expect((await eliminar(OBJETIVO_ID)).status).toBe(403);
    nadaCambio();
  });
});
