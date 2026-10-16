// @vitest-environment node
/**
 * La sección de SSO en /configuracion (B19): quién la ve y qué pinta.
 *
 * El panel se lee aparte del resto de lo de admin (`ssoParaAdmin`) para que una
 * base sin la 0045 no esconda los montos ni la entrega al core. Acá se afirma lo
 * que la página hace con eso: sólo un administrador llega a leerlo, y lo que
 * viene en `?sso=` se pinta únicamente si es un nombre de la lista cerrada.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getSessionContext: vi.fn(),
  getUserRow: vi.fn(),
  paraAdmin: vi.fn(),
  ssoParaAdmin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": "es-AR" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: m.getSessionContext }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRow: m.getUserRow }));
vi.mock("@/server/ai/provider", () => ({ getUserGeminiKey: async () => null }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: async () => "es-AR" }));
vi.mock("@/app/(app)/configuracion/para-admin", () => ({ paraAdmin: m.paraAdmin, ssoParaAdmin: m.ssoParaAdmin }));
vi.mock("@/app/(app)/configuracion/sso-actions", () => ({
  guardarSso: vi.fn(),
  verificarSso: vi.fn(),
  cambiarSso: vi.fn(),
  probarSso: vi.fn(),
}));
vi.mock("@/app/(app)/configuracion/numero-actions", () => ({
  pedirCodigoDelNumero: vi.fn(),
  verificarCodigoDelNumero: vi.fn(),
}));
// Los paneles de cliente de las demás secciones no se prueban acá.
for (const modulo of [
  "ConfiguracionClient",
  "GmailAccountsPanel",
  "UserAiKeyPanel",
  "AlertasPanel",
  "GoogleVinculo",
  "CoreSyncPanel",
  "MontosPanel",
]) {
  vi.doMock(`@/app/(app)/configuracion/${modulo}`, () => ({ [modulo]: () => null }));
}

import type { PanelSso } from "@/server/sso/panel";

const TENANT = "10000000-0000-0000-0000-000000000001";
const PANEL: PanelSso = {
  issuer: null,
  client_id: null,
  dominio: null,
  dominio_verificado_en: null,
  activo: false,
  exigir: false,
  tiene_secreto: false,
  registro: null,
  url_de_vuelta: "https://claimmix.example.com/api/auth/sso-inquilino/callback",
  migracion_pendiente: false,
};

async function pintar(sso?: string) {
  const { default: Pagina } = await import("@/app/(app)/configuracion/page");
  return renderToStaticMarkup(await Pagina({ searchParams: Promise.resolve(sso === undefined ? {} : { sso }) }));
}

function conRol(role: string) {
  m.getSessionContext.mockResolvedValue({ user: { id: "u1", email: "ana@empresa.com" } });
  m.getUserRow.mockResolvedValue({ id: "u1", tenant_id: TENANT, role, full_name: "Ana", plan: "pro" });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.paraAdmin.mockResolvedValue({ alertas: [], migracionPendiente: false });
  m.ssoParaAdmin.mockResolvedValue(PANEL);
});

afterEach(() => {
  delete process.env.MONTHLY_BUDGET_USD;
});

describe("/configuracion: sección de SSO", () => {
  it.each(["owner", "admin"])("un %s la ve, leída del inquilino de su fila y no de la dirección", async (role) => {
    conRol(role);

    const html = await pintar();

    expect(html).toContain("Inicio de sesión único");
    expect(html).toContain("https://claimmix.example.com/api/auth/sso-inquilino/callback");
    expect(m.ssoParaAdmin).toHaveBeenCalledExactlyOnceWith(TENANT);
  });

  it.each(["analyst", "viewer", "supervisor", "desconocido"])(
    "un %s no la ve, y ni siquiera se lee: la configuración del SSO no sale de la base",
    async (role) => {
      conRol(role);

      const html = await pintar();

      expect(html).not.toContain("Inicio de sesión único");
      expect(html).not.toContain("sso-issuer");
      expect(m.ssoParaAdmin).not.toHaveBeenCalled();
    }
  );

  it("sin fila de usuario no hay lectura del SSO", async () => {
    m.getSessionContext.mockResolvedValue({ user: { id: "u1", email: "ana@empresa.com" } });
    m.getUserRow.mockResolvedValue(null);

    await pintar();

    expect(m.ssoParaAdmin).not.toHaveBeenCalled();
  });

  it("si el panel no se pudo leer la sección no aparece, pero la página sí", async () => {
    conRol("admin");
    m.ssoParaAdmin.mockResolvedValue(null);

    const html = await pintar();

    expect(html).not.toContain("Inicio de sesión único");
    expect(html).toContain("Preferencias de cuenta");
  });

  it("sin la 0045 muestra el aviso de la migración, no un formulario", async () => {
    conRol("admin");
    m.ssoParaAdmin.mockResolvedValue({ ...PANEL, migracion_pendiente: true });

    const html = await pintar();

    expect(html).toContain("Inicio de sesión único");
    expect(html).not.toContain("sso-issuer");
  });

  it("el resultado de la última acción, si es de la lista, se pinta con su texto", async () => {
    conRol("admin");

    const html = await pintar("dominioPublico");

    expect(html).toContain('role="status"');
    expect(html).toContain("gmail.com");
  });

  it.each(["<script>alert(1)</script>", "guardado%3Cb%3E", "__proto__", "constructor", "", "GUARDADO"])(
    "un `?sso=` que no es de la lista (%j) no pinta nada",
    async (valor) => {
      conRol("admin");

      const html = await pintar(valor);

      expect(html).not.toContain('role="status"');
      expect(html).not.toContain("alert(1)");
    }
  );

  it("un administrador de otro inquilino no cambia lo que se lee: el inquilino sale siempre de su propia fila", async () => {
    conRol("admin");
    m.getUserRow.mockResolvedValue({ id: "u1", tenant_id: "20000000-0000-0000-0000-000000000002", role: "admin", full_name: "Ana", plan: "pro" });

    await pintar();

    expect(m.ssoParaAdmin).toHaveBeenCalledExactlyOnceWith("20000000-0000-0000-0000-000000000002");
  });
});

/**
 * El tope mensual de IA que muestra la página es el que lee el guardia, no un
 * 200 escrito a mano: con `MONTHLY_BUDGET_USD=0` la IA está frenada y la página
 * no puede decir USD 200.
 */
describe("/configuracion: tope mensual de IA", () => {
  it.each(["admin", "analyst"])("un %s ve el tope del proyecto, 200 si no está puesto", async (role) => {
    conRol(role);

    expect(await pintar()).toContain("USD 200");
  });

  it("con MONTHLY_BUDGET_USD puesto muestra ese número", async () => {
    conRol("admin");
    process.env.MONTHLY_BUDGET_USD = "49.5";

    const html = await pintar();

    expect(html).toContain("USD 49.5");
    expect(html).not.toContain("USD 200");
  });

  it.each(["admin", "analyst"])("con el tope en 0, un %s ve que la IA está frenada y no USD 0 ni USD 200", async (role) => {
    conRol(role);
    process.env.MONTHLY_BUDGET_USD = "0";

    const html = await pintar();

    expect(html).toContain("IA frenada (tope en 0)");
    expect(html).not.toContain("USD 0");
    expect(html).not.toContain("USD 200");
  });
});
