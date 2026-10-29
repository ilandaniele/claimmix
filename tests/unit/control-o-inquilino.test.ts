/**
 * Casillas de Gmail, formulario, SSO y la membresía del panel de sesiones viven
 * en la base de control: van por `enControl`, no por `enTenant`.
 *
 * Con `BASE_POR_CLIENTE` apagada las dos puertas llevan a la misma base y un
 * `enTenant` de más no se nota; con la bandera prendida la consulta cae en la
 * base del cliente, donde esas tablas están vacías. Acá se afirma que cada sitio
 * toca la puerta de control y no la del inquilino, y que /agente, que lee del
 * inquilino y de control en la misma pantalla, parte la lectura sólo con la
 * bandera prendida.
 */

import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  puertas: [] as string[],
  consultas: [] as string[],
  requireAdmin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/db", () => ({ db: {}, tables: {} }));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: async () => "es-AR" }));
vi.mock("@/data/scope", async () => {
  const base = drizzle(async (sql) => {
    h.consultas.push(sql);
    return { rows: sql.includes('"formulario_web"') ? [["mi-enlace", true]] : [] };
  });
  const puerta = (nombre: string) => async (_ctx: unknown, armar: (db: unknown) => unknown) => {
    h.puertas.push(nombre);
    return await armar(base);
  };
  return {
    enTenant: puerta("enTenant"),
    enControl: puerta("enControl"),
    enTenantVarias: async (_ctx: unknown, armar: (db: unknown) => unknown[]) => {
      h.puertas.push("enTenantVarias");
      return await Promise.all(armar(base));
    },
    enControlVarias: async (_ctx: unknown, armar: (db: unknown) => unknown[]) => {
      h.puertas.push("enControlVarias");
      return await Promise.all(armar(base));
    },
  };
});

import AgentConsolePage from "@/app/(app)/agente/page";
import { getGmailAccountForTenant } from "@/server/email/gmail/accounts";
import { configVigenteDelInquilino } from "@/server/sso/config";
import { panelSso } from "@/server/sso/panel";
import { correoExigeSso } from "@/server/sso/usuarios";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.unstubAllEnvs();
  h.puertas.length = 0;
  h.consultas.length = 0;
  h.requireAdmin.mockResolvedValue({ user: { id: "u-1" }, userRow: { role: "admin", tenant_id: TENANT_ID } });
});

describe("las consultas de control salen por enControl", () => {
  it("la casilla de Gmail del inquilino", async () => {
    await getGmailAccountForTenant(TENANT_ID);
    expect(h.puertas).toEqual(["enControl"]);
  });

  it("la config de SSO vigente del inquilino", async () => {
    await configVigenteDelInquilino(TENANT_ID);
    expect(h.puertas).toEqual(["enControl"]);
  });

  it("el panel de SSO", async () => {
    await panelSso(TENANT_ID);
    expect(h.puertas).toEqual(["enControl"]);
  });

  it("si el mail de una invitación exige SSO", async () => {
    await correoExigeSso("ana@example.com", TENANT_ID);
    expect(h.puertas).toEqual(["enControl"]);
  });
});

describe("/agente lee ramos del inquilino y formulario de control", () => {
  type Nodo = { props?: { children?: Nodo | Nodo[]; formulario?: Nodo & { props: { formulario: unknown } } } };
  const consola = (nodo: Nodo | Nodo[] | undefined): Nodo | undefined => {
    if (!nodo) return undefined;
    if (Array.isArray(nodo)) return nodo.map((n) => consola(n)).find(Boolean);
    return nodo?.props?.formulario ? nodo : consola(nodo?.props?.children);
  };
  const formularioDe = async () => consola((await AgentConsolePage({ searchParams: Promise.resolve({}) })) as Nodo)?.props?.formulario?.props.formulario;

  it("apagada la bandera, un solo lote por la puerta del inquilino", async () => {
    expect(await formularioDe()).toEqual({ slug: "mi-enlace", activo: true });
    expect(h.puertas).toEqual(["enTenantVarias"]);
  });

  it("prendida la bandera, ramos por enTenant y formulario por enControl", async () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    expect(await formularioDe()).toEqual({ slug: "mi-enlace", activo: true });
    expect([...h.puertas].sort()).toEqual(["enControl", "enTenant"]);
    expect(h.consultas.filter((q) => q.includes('"formulario_web"'))).toHaveLength(1);
  });
});

describe("ningún archivo de control vuelve a enTenant", () => {
  const llamadas = (archivo: string, puerta: string) => {
    const codigo = readFileSync(archivo, "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    return (codigo.match(new RegExp(`\\b${puerta}(?:Varias)?\\(`, "g")) ?? []).length;
  };

  it.each([
    ["src/server/email/gmail/accounts.ts", 2],
    ["src/app/api/admin/gmail-accounts/route.ts", 3],
    ["src/app/api/admin/gmail-accounts/callback/route.ts", 1],
    ["src/app/api/admin/formulario-web/route.ts", 2],
    ["src/server/sso/config.ts", 1],
    ["src/server/sso/usuarios.ts", 1],
    ["src/server/sso/panel.ts", 1],
    ["src/app/api/admin/sso/route.ts", 3],
    ["src/app/api/admin/users/[id]/sessions/route.ts", 1],
  ])("%s: %i llamada(s) a enControl y ninguna a enTenant", (archivo, esperadas) => {
    expect(llamadas(archivo, "enControl")).toBe(esperadas);
    expect(llamadas(archivo, "enTenant")).toBe(0);
  });

  it("formulario-del-inquilino.ts arma consultas y no abre ninguna puerta", () => {
    const archivo = "src/server/web/formulario-del-inquilino.ts";
    expect(llamadas(archivo, "enControl")).toBe(0);
    expect(llamadas(archivo, "enTenant")).toBe(0);
  });
});
