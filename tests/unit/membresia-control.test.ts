/**
 * Usuarios, roles y membresía se escriben en control y de ahí se espejan a la
 * base del cliente.
 *
 * Con `BASE_POR_CLIENTE` prendida la identidad vive en `neondb` y la copia en
 * `t_<hex>` la escribe sólo `espejar`. Acá se afirma, sitio por sitio, que la
 * escritura sale por `enControl` o `enControlVarias` (no por `enTenant`, que
 * caería en la base del cliente), que el espejo corre DESPUÉS de la escritura y con el inquilino
 * correcto, y que si el espejo falla la operación igual contesta bien: el cambio
 * ya está en control y el barrido levanta la copia.
 */

import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/pg-proxy";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Lo que pasó, en orden: la puerta que se abrió y el espejo que se pidió. */
  orden: [] as string[],
  /** Contextos con que se abrió cada puerta. */
  contextos: [] as unknown[],
  /** Las filas (en modo arreglo) que va devolviendo la base, una tanda por consulta. */
  respuestas: [] as unknown[][][],
  /** Si está, la base tira este error en vez de contestar. */
  falla: null as Error | null,
  espejar: vi.fn(),
  warn: vi.fn(),
  requireAdmin: vi.fn(),
  audit: vi.fn(),
  perfil: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", async () => {
  const base = drizzle(async () => {
    if (h.falla) throw h.falla;
    return { rows: h.respuestas.shift() ?? [] };
  });
  const puerta = (nombre: string) => async (ctx: unknown, armar: (db: unknown) => unknown) => {
    h.orden.push(nombre);
    h.contextos.push(ctx);
    return await armar(base);
  };
  // Una tras otra, en el orden del lote: así cada consulta recibe su tanda.
  const lote = async (ctx: unknown, armar: (db: unknown) => PromiseLike<unknown>[]) => {
    h.orden.push("enControlVarias");
    h.contextos.push(ctx);
    const resultados: unknown[] = [];
    for (const consulta of armar(base)) resultados.push(await consulta);
    return resultados;
  };
  return { enTenant: puerta("enTenant"), enControl: puerta("enControl"), enControlVarias: lote };
});
vi.mock("@/lib/db", async () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => h.perfil }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  tables: await import("@/lib/db/schema"),
}));
vi.mock("@/server/bases/espejo", () => ({ espejar: h.espejar }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ olvidarFilaDeUsuario: vi.fn() }));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: h.audit,
}));
vi.mock("@/lib/auth/sesiones", () => ({ cerrarSesiones: vi.fn(async () => 0) }));
vi.mock("@/server/notify/remitente-sistema", () => ({ remitenteDelSistema: () => ({ de: "no-responder@example.com" }) }));
vi.mock("@/server/sso/usuarios", () => ({ correoExigeSso: vi.fn(async () => false) }));
vi.mock("@/lib/security/cifrado", () => ({ descifrar: (s: string) => s }));

import { aceptarInvitacion, resumenDeInvitacion, type DatosDeInvitacion } from "@/server/alta/invitacion";
import { PATCH } from "@/app/api/admin/users/[id]/route";
import { onPasswordReset } from "@/lib/auth/on-password-reset";
import { provisionUserProfile } from "@/lib/auth/provision";
import { enIngresoPorSso } from "@/lib/auth/registro-permitido";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { credencialesWhatsApp } from "@/server/whatsapp/numeros";

const ESPACIO = "aaaaaaaa-0000-4000-8000-00000000000a";
const PLATAFORMA = "10000000-0000-4000-8000-000000000001";
const ADMIN = "bbbbbbbb-0000-4000-8000-00000000000b";
const PERSONA = "dddddddd-0000-4000-8000-00000000000d";
const INVITACION: DatosDeInvitacion = {
  t: ESPACIO,
  e: "lucia@example.com",
  r: "analyst",
  n: "Lucía Fernández",
  i: ADMIN,
  exp: Date.now() + 60_000,
};
const QUIEN = { userId: PERSONA, ip: "203.0.113.9", ua: "vitest" };

/** El espejo cae con un error que lleva una dirección adentro, como el del driver. */
const espejoCaido = () =>
  h.espejar.mockRejectedValue(Object.assign(new Error("falló la fila de ana@example.com"), { code: "08006" }));

beforeEach(() => {
  vi.unstubAllEnvs();
  h.orden.length = 0;
  h.contextos.length = 0;
  h.respuestas.length = 0;
  h.falla = null;
  h.perfil = [];
  h.warn.mockReset();
  h.audit.mockReset();
  h.espejar.mockReset();
  h.espejar.mockImplementation(async (tenantId: string) => void h.orden.push(`espejar:${tenantId}`));
});

describe("espejarSinFallar", () => {
  it("devuelve true si la copia entró", async () => {
    expect(await espejarSinFallar(ESPACIO)).toBe(true);
    expect(h.espejar).toHaveBeenCalledWith(ESPACIO);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("si la copia falla no tira: devuelve false y anota sólo el código, nunca el mensaje", async () => {
    espejoCaido();

    expect(await espejarSinFallar(ESPACIO)).toBe(false);

    expect(h.warn).toHaveBeenCalledWith({ tenantId: ESPACIO, detalle: "08006" }, "bases.espejo_pendiente");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("ana@example.com");
  });

  it("si la copia falla una vez y la segunda entra, devuelve true y no anota nada", async () => {
    h.espejar.mockRejectedValueOnce(Object.assign(new Error("falló la fila de ana@example.com"), { code: "08006" }));

    expect(await espejarSinFallar(ESPACIO)).toBe(true);

    expect(h.espejar).toHaveBeenCalledTimes(2);
    expect(h.espejar).toHaveBeenNthCalledWith(2, ESPACIO);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("si falla las dos veces devuelve false con un solo aviso, y el aviso no lleva el mensaje", async () => {
    espejoCaido();

    expect(await espejarSinFallar(ESPACIO)).toBe(false);

    expect(h.espejar).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ tenantId: ESPACIO, detalle: "08006" }, "bases.espejo_pendiente");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("ana@example.com");
  });

  it.each([
    ["en el error", { code: "3D000" }],
    ["en su causa", { cause: { code: "3D000" } }],
  ])("con la base inexistente (3D000 %s) no reintenta", async (_donde, extra) => {
    h.espejar.mockRejectedValue(Object.assign(new Error("database does not exist"), extra));

    expect(await espejarSinFallar(ESPACIO)).toBe(false);

    expect(h.espejar).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ tenantId: ESPACIO, detalle: "3D000" }, "bases.espejo_pendiente");
  });
});

describe("la invitación", () => {
  it("aceptar escribe en control y espeja después, con el espacio del enlace", async () => {
    h.respuestas.push([[PERSONA]]);

    expect(await aceptarInvitacion(INVITACION, QUIEN)).toBe(true);

    expect(h.orden).toEqual(["enControl", `espejar:${ESPACIO}`]);
    expect(h.contextos).toEqual([{ tenantId: ESPACIO }]);
  });

  it("si no se creó el perfil no hay nada que espejar", async () => {
    h.respuestas.push([]);

    expect(await aceptarInvitacion(INVITACION, QUIEN)).toBe(false);

    expect(h.orden).toEqual(["enControl"]);
    expect(h.espejar).not.toHaveBeenCalled();
  });

  it("si el espejo falla la invitación igual queda aceptada", async () => {
    espejoCaido();
    h.respuestas.push([[PERSONA]]);

    expect(await aceptarInvitacion(INVITACION, QUIEN)).toBe(true);

    expect(h.warn).toHaveBeenCalledWith({ tenantId: ESPACIO, detalle: "08006" }, "bases.espejo_pendiente");
  });

  it("el resumen lee de control y no espeja nada", async () => {
    h.respuestas.push([["Seguros Ejemplo", "active", "Jefa Ejemplo", "admin"]]);

    await resumenDeInvitacion(INVITACION);

    expect(h.orden).toEqual(["enControl"]);
    expect(h.espejar).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/users/:id", () => {
  const OBJETIVO = "eeeeeeee-0000-4000-8000-00000000000e";
  const pedir = () =>
    PATCH(
      new NextRequest(`http://localhost/api/admin/users/${OBJETIVO}`, {
        method: "PATCH",
        body: JSON.stringify({ role: "analyst" }),
      }),
      { params: Promise.resolve({ id: OBJETIVO }) }
    );

  beforeEach(() => {
    h.requireAdmin.mockResolvedValue({ user: { id: ADMIN }, userRow: { role: "admin", tenant_id: ESPACIO } });
    // Una tanda por sentencia del lote: el candado, el rol de antes y la fila ya cambiada.
    h.respuestas.push([], [["viewer"]], [[OBJETIVO, "Ana", "analyst", "2026-01-01T00:00:00.000Z", null]]);
  });

  it("lee y escribe por control en un solo lote, y espeja el espacio de quien cambia el rol cuando ya escribió", async () => {
    const res = await pedir();

    expect(res.status).toBe(200);
    expect(h.orden).toEqual(["enControlVarias", `espejar:${ESPACIO}`]);
    expect(h.contextos).toEqual([{ tenantId: ESPACIO }]);
  });

  it("si el espejo falla el cambio de rol contesta bien", async () => {
    espejoCaido();

    const res = await pedir();

    expect(res.status).toBe(200);
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: ESPACIO, detalle: "08006" }, "bases.espejo_pendiente");
  });

  it("si el usuario no existe en el espacio no escribe ni espeja", async () => {
    h.respuestas.length = 0;

    const res = await pedir();

    expect(res.status).toBe(404);
    expect(h.orden).toEqual(["enControlVarias"]);
    expect(h.espejar).not.toHaveBeenCalled();
  });
});

describe("provisionUserProfile", () => {
  const sso = { tenantId: ESPACIO, dominio: "example.com" };

  it("el perfil del SSO se escribe por control y se espeja al espacio del IdP", async () => {
    await enIngresoPorSso(sso, () =>
      provisionUserProfile({ id: PERSONA, name: "Ana", email: "ana@example.com", emailVerified: true })
    );

    expect(h.orden).toEqual(["enControl", `espejar:${ESPACIO}`]);
    expect(h.contextos).toEqual([{ tenantId: ESPACIO }]);
  });

  it("si el espejo falla el alta por SSO no se cae, y el login paga dos intentos, no más", async () => {
    espejoCaido();

    await expect(
      enIngresoPorSso(sso, () =>
        provisionUserProfile({ id: PERSONA, name: "Ana", email: "ana@example.com", emailVerified: true })
      )
    ).resolves.toBeUndefined();

    expect(h.espejar).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it("el perfil del operador se escribe por control en el inquilino por omisión y se espeja ahí", async () => {
    vi.stubEnv("ADMIN_EMAILS", "jefe@example.com");
    vi.stubEnv("GOOGLE_DEFAULT_TENANT_ID", PLATAFORMA);

    await provisionUserProfile({ id: PERSONA, name: "Jefe", email: "jefe@example.com", emailVerified: true });

    expect(h.orden).toEqual(["enControl", `espejar:${PLATAFORMA}`]);
    expect(h.contextos).toEqual([{ tenantId: PLATAFORMA }]);
  });

  it("si el espejo falla el alta del operador no se cae", async () => {
    espejoCaido();
    vi.stubEnv("ADMIN_EMAILS", "jefe@example.com");
    vi.stubEnv("GOOGLE_DEFAULT_TENANT_ID", PLATAFORMA);

    await expect(
      provisionUserProfile({ id: PERSONA, name: "Jefe", email: "jefe@example.com", emailVerified: true })
    ).resolves.toBeUndefined();
  });

  it("una cuenta sin perfil no escribe ni espeja nada", async () => {
    await provisionUserProfile({ id: PERSONA, name: "Eva", email: "eva@example.com", emailVerified: true });

    expect(h.orden).toEqual([]);
    expect(h.espejar).not.toHaveBeenCalled();
  });
});

describe("onPasswordReset", () => {
  const usuario = { id: PERSONA, email: "ana@example.com", name: "Ana" };

  it("con perfil, espeja el espacio de la cuenta (la marca del correo vive en control)", async () => {
    h.perfil = [{ tenant_id: ESPACIO }];

    await onPasswordReset(usuario);

    expect(h.espejar).toHaveBeenCalledWith(ESPACIO);
  });

  it("si el espejo falla igual anota el restablecimiento", async () => {
    espejoCaido();
    h.perfil = [{ tenant_id: ESPACIO }];

    await onPasswordReset(usuario);

    expect(h.audit).toHaveBeenCalledOnce();
  });

  it("sin perfil no hay espacio que espejar", async () => {
    await onPasswordReset(usuario);

    expect(h.espejar).not.toHaveBeenCalled();
  });
});

describe("credencialesWhatsApp", () => {
  it("lee el número y el token de control, no de la base del cliente", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "fake-access-token");
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "200000000000001");
    h.respuestas.push([["conectado", "100000000000777", "200000000000001", null, "active", null, false, null, null, null, null]]);

    const credenciales = await credencialesWhatsApp(ESPACIO);

    expect(credenciales).toMatchObject({ phoneNumberId: "100000000000777", tenantId: ESPACIO });
    expect(h.orden).toEqual(["enControl"]);
    expect(h.contextos).toEqual([{ tenantId: ESPACIO }]);
  });

  it("si la base falla no tira: devuelve null", async () => {
    h.falla = Object.assign(new Error("base caída"), { code: "08006" });

    expect(await credencialesWhatsApp(ESPACIO)).toBeNull();
  });
});

describe("ningún sitio de membresía vuelve a enTenant", () => {
  const llamadas = (archivo: string, puerta: string) => {
    const codigo = readFileSync(archivo, "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    return codigo.split(`${puerta}(`).length - 1 + codigo.split(`${puerta}Varias(`).length - 1;
  };

  it.each([
    ["src/server/alta/invitacion.ts", 2],
    // Una: baja, alta y rol van en un solo lote con el candado del espacio.
    ["src/app/api/admin/users/[id]/route.ts", 1],
    ["src/lib/auth/provision.ts", 2],
    // Dos, y se corre una: la lectura con la WABA y la de respaldo para cuando falta la 0051.
    ["src/server/whatsapp/numeros.ts", 2],
  ])("%s: %i llamada(s) a enControl y ninguna a enTenant", (archivo, esperadas) => {
    expect(llamadas(archivo, "enControl")).toBe(esperadas);
    expect(llamadas(archivo, "enTenant")).toBe(0);
  });
});
