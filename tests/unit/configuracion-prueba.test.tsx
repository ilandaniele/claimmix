// @vitest-environment node
/**
 * La prueba y el número de WhatsApp en /configuracion (alta automática): lo que
 * lee `paraAdmin`, cuándo lo pinta la página y qué dice. Es sólo para leer.
 *
 * La base se reemplaza en `enTenantVarias`, así que `paraAdmin` y la página
 * corren de verdad, uno sobre el otro.
 */

import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/pg-proxy";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  enTenantVarias: vi.fn(),
  listaDelTenant: vi.fn(),
  panelSso: vi.fn(),
  getSessionContext: vi.fn(),
  getUserRow: vi.fn(),
  locale: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": "es-AR" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/data/scope", () => ({ enTenantVarias: m.enTenantVarias }));
vi.mock("@/server/notify/specialist-alert", () => ({ listaDelTenant: m.listaDelTenant }));
vi.mock("@/server/sso/panel", () => ({ panelSso: m.panelSso }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: m.getSessionContext }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRow: m.getUserRow }));
vi.mock("@/server/ai/provider", () => ({ getUserGeminiKey: async () => null }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: m.locale }));
vi.mock("@/app/(app)/configuracion/sso-actions", () => ({
  guardarSso: vi.fn(),
  verificarSso: vi.fn(),
  cambiarSso: vi.fn(),
  probarSso: vi.fn(),
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

import { getT } from "@/lib/i18n";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { PruebaPanel } from "@/app/(app)/configuracion/PruebaPanel";
import { paraAdmin } from "@/app/(app)/configuracion/para-admin";

const TENANT = "10000000-0000-0000-0000-000000000001";
const AHORA = new Date("2026-10-08T12:00:00.000Z");
const VISTA = { webhook_url: "https://core.aseguradora.com.ar/hook", enabled: true };
const falta = (code: string) => Object.assign(new Error("no existe"), { code });
const enDias = (dias: number) => new Date(AHORA.getTime() + dias * 24 * 60 * 60 * 1000).toISOString();

/** Lo que devuelve el lote con la 0048 aplicada. */
function lote(
  tenant: { billing_status?: string; trial_ends_at?: string | null; autoalta?: boolean | null },
  numeros: Array<{ estado: string }> = []
) {
  return [[{ emails: [], horas: [], montos: null, billing_status: "trial", trial_ends_at: enDias(12), autoalta: true, ...tenant }], [VISTA], numeros];
}

/** Las consultas que armó la llamada `llamada` al lote. */
function armadas(llamada: number): Array<{ toSQL: () => { sql: string; params: unknown[] } }> {
  const armar = m.enTenantVarias.mock.calls[llamada][1] as (db: unknown) => ReturnType<typeof armadas>;
  return armar(drizzle(async () => ({ rows: [] })));
}

/** El SQL de la consulta `n` del lote que armó la llamada `llamada`. */
const consulta = (llamada: number, n: number) => armadas(llamada)[n].toSQL();

async function pintar() {
  const { default: Pagina } = await import("@/app/(app)/configuracion/page");
  return renderToStaticMarkup(await Pagina({ searchParams: Promise.resolve({}) }));
}

function conRol(role: string) {
  m.getSessionContext.mockResolvedValue({ user: { id: "u1", email: "ana@example.com" } });
  m.getUserRow.mockResolvedValue({ id: "u1", tenant_id: TENANT, role, full_name: "Ana", plan: "piloto" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: AHORA, toFake: ["Date"] });
  m.listaDelTenant.mockResolvedValue([]);
  m.panelSso.mockRejectedValue(falta("42P01"));
  m.locale.mockResolvedValue("es-AR");
  conRol("owner");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("paraAdmin: la prueba y el número", () => {
  it("las lee en el mismo lote que lo demás: un solo viaje", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    await paraAdmin(TENANT);

    expect(m.enTenantVarias).toHaveBeenCalledOnce();
    expect(armadas(0)).toHaveLength(3);
    expect(consulta(0, 0).sql).toContain('(to_jsonb("tenants".*) ->> \'autoalta\')::boolean');
  });

  it("del número sólo lee el estado, y deja afuera lo dado de baja", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    await paraAdmin(TENANT);

    const { sql, params } = consulta(0, 2);
    expect(sql).toMatch(/^select "estado" from "whatsapp_numeros" where "whatsapp_numeros"\."estado" <> \$1/);
    expect(params).toEqual(["baja", 1]);
    for (const columna of ["numero_e164", "phone_number_id", "waba_id", "token_cifrado"]) expect(sql).not.toContain(columna);
  });

  it.each([
    ["quedan 12 días justos", enDias(12), 12],
    ["una hora más de un día completo cuenta el día entero", enDias(12.05), 13],
    ["menos de un día queda 1", enDias(0.1), 1],
  ])("%s", async (_caso, fin, dias) => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ trial_ends_at: fin }));

    await expect(paraAdmin(TENANT)).resolves.toMatchObject({ prueba: { dias, numero: "pedido" } });
  });

  it.each([
    ["la fecha de fin ya pasó", enDias(-1)],
    ["justo ahora", enDias(0)],
    ["la fecha no se puede leer", "no-es-una-fecha"],
  ])("vencida (%s): 0 días", async (_caso, fin) => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ trial_ends_at: fin }));

    await expect(paraAdmin(TENANT)).resolves.toMatchObject({ prueba: { dias: 0 } });
  });

  it.each([
    ["ya paga un plan", { billing_status: "active" }],
    ["no tiene fecha de fin", { trial_ends_at: null }],
  ])("sin días que contar si %s", async (_caso, tenant) => {
    m.enTenantVarias.mockResolvedValueOnce(lote(tenant));

    await expect(paraAdmin(TENANT)).resolves.toMatchObject({ prueba: { dias: null } });
  });

  it.each([
    ["sin fila", [], "pedido"],
    ["pedido", [{ estado: "pedido" }], "pedido"],
    ["conectado", [{ estado: "conectado" }], "conectado"],
    ["suspendido", [{ estado: "suspendido" }], "suspendido"],
  ])("número %s", async (_caso, numeros, numero) => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}, numeros));

    await expect(paraAdmin(TENANT)).resolves.toMatchObject({ prueba: { numero } });
  });

  it.each([
    ["no es del alta automática (el de siempre)", { autoalta: false }],
    ["la 0048 no está y la columna llega vacía", { autoalta: null }],
  ])("sin panel si el espacio %s", async (_caso, tenant) => {
    m.enTenantVarias.mockResolvedValueOnce(lote(tenant));

    const admin = await paraAdmin(TENANT);

    expect(admin).not.toHaveProperty("prueba");
    expect(admin.alertas).toEqual([]);
  });

  it("antes de la 0048 (42P01) rehace el lote sin esas lecturas: sin panel y con lo demás", async () => {
    m.enTenantVarias
      .mockRejectedValueOnce(falta("42P01"))
      .mockResolvedValueOnce([[{ emails: ["a@example.com"], horas: [48], montos: null }], [VISTA]]);

    const admin = await paraAdmin(TENANT);

    expect(admin).toEqual({ alertas: ["a@example.com"], recordatorioHoras: [48], montos: null, core: VISTA, migracionPendiente: false });
    expect(m.enTenantVarias).toHaveBeenCalledTimes(2);
    expect(consulta(1, 0).sql).not.toContain("billing_status");
    expect(consulta(1, 0).sql).not.toContain("autoalta");
    expect(armadas(1)).toHaveLength(2);
  });

  it("otro error de la base no lo rehace: la lista sola, sin panel", async () => {
    m.enTenantVarias.mockRejectedValueOnce(falta("57P01"));

    const admin = await paraAdmin(TENANT);

    expect(admin).toEqual({ alertas: [], migracionPendiente: false });
    expect(m.enTenantVarias).toHaveBeenCalledOnce();
  });
});

describe("/configuracion con la prueba", () => {
  it.each(["owner", "admin"])("un %s ve cuántos días le quedan y que el WhatsApp está pendiente", async (role) => {
    conRol(role);
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar();

    expect(html).toContain("Tu prueba y tu WhatsApp");
    expect(html).toContain("Quedan 12 días");
    expect(html).toContain("Pendiente de conexión");
    expect(html).toContain("Lo conectamos nosotros y te avisamos.");
  });

  it("en inglés, con las mismas dos cosas", async () => {
    m.locale.mockResolvedValue("en-US");
    m.enTenantVarias.mockResolvedValueOnce(lote({}, [{ estado: "conectado" }]));

    const html = await pintar();

    expect(html).toContain("Your trial and your WhatsApp");
    expect(html).toContain("12 days left");
    expect(html).toContain("Connected");
    expect(html).not.toContain("We connect it ourselves");
  });

  it("la prueba vencida lo dice, y con el número suspendido también", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ trial_ends_at: enDias(-3) }, [{ estado: "suspendido" }]));

    const html = await pintar();

    expect(html).toContain("Terminó. Escribinos para pasar a un plan.");
    expect(html).toContain("Suspendido");
    expect(html).not.toContain("Quedan");
  });

  it("un espacio sin fila de número se ve igual que uno con el número pedido (H3)", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}, []));
    const sinFila = await pintar();
    m.enTenantVarias.mockResolvedValueOnce(lote({}, [{ estado: "pedido" }]));
    const conPedido = await pintar();

    expect(sinFila).toBe(conPedido);
    expect(sinFila).toContain("Pendiente de conexión");
  });

  it("un espacio que ya paga un plan no cuenta días, pero sí muestra el número", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ billing_status: "active" }, [{ estado: "conectado" }]));

    const html = await pintar();

    expect(html).toContain("Conectado");
    expect(html).not.toContain("Quedan");
    expect(html).not.toContain("Terminó");
  });

  it("antes de la 0048 la página carga sin el panel", async () => {
    m.enTenantVarias
      .mockRejectedValueOnce(falta("42P01"))
      .mockResolvedValueOnce([[{ emails: [], horas: [], montos: null }], [VISTA]]);

    const html = await pintar();

    expect(html).toContain("Configuración");
    expect(html).not.toContain("Tu prueba y tu WhatsApp");
  });

  it("el espacio de siempre no tiene panel", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ autoalta: false }));

    expect(await pintar()).not.toContain("Tu prueba y tu WhatsApp");
  });

  it("quien no administra no lo ve, y no se lee nada", async () => {
    conRol("analyst");

    const html = await pintar();

    expect(html).not.toContain("Tu prueba y tu WhatsApp");
    expect(m.enTenantVarias).not.toHaveBeenCalled();
  });
});

describe("PruebaPanel", () => {
  it("no tiene nada que se pueda editar", () => {
    const t = getT("es-AR");
    for (const numero of ["pedido", "conectado", "suspendido"] as const) {
      const html = renderToStaticMarkup(<PruebaPanel prueba={{ dias: 5, numero }} t={t} />);
      for (const control of ["<input", "<button", "<form", "<select", "<textarea", "<a "]) expect(html).not.toContain(control);
    }
  });

  it("dice 'queda 1 día' en singular", () => {
    expect(renderToStaticMarkup(<PruebaPanel prueba={{ dias: 1, numero: "pedido" }} t={getT("es-AR")} />)).toContain("Queda 1 día");
    expect(renderToStaticMarkup(<PruebaPanel prueba={{ dias: 1, numero: "pedido" }} t={getT("en-US")} />)).toContain("1 day left");
  });

  it("es de servidor: no baja JavaScript al navegador", () => {
    const fuente = readFileSync("src/app/(app)/configuracion/PruebaPanel.tsx", "utf8");

    expect(fuente).not.toMatch(/["']use client["']/);
    expect(fuente).not.toMatch(/\buse(State|Effect|T|Transition)\b/);
  });
});

describe("los textos de la prueba", () => {
  const claves = (d: object) => Object.keys(d).filter((k) => k.startsWith("configuracion.prueba."));

  it("están en los dos idiomas, y de servidor para no pesar en el navegador", () => {
    expect(claves(enUSServidor).sort()).toEqual(claves(esARServidor).sort());
    expect(claves(esARServidor).length).toBeGreaterThan(0);
  });

  it("en inglés no queda español, salvo el nombre de WhatsApp", () => {
    for (const clave of claves(esARServidor)) {
      const es = (esARServidor as Record<string, string>)[clave]!;
      const en = (enUSServidor as Record<string, string>)[clave]!;
      expect(en, clave).toBeTruthy();
      if (clave !== "configuracion.prueba.whatsapp") expect(en, clave).not.toBe(es);
    }
  });
});
