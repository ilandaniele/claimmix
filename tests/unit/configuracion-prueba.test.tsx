// @vitest-environment node
/**
 * La prueba y el número de WhatsApp en /configuracion (alta automática): lo que
 * lee `paraAdmin`, cuándo lo pinta la página y qué dice. Es sólo para leer.
 *
 * La base se reemplaza en `enTenantVarias`, así que `paraAdmin` y la página
 * corren de verdad, uno sobre el otro. Lo que está conectado (`pasosHechos`) se
 * reemplaza aparte: de ahí salen los «Primeros pasos», no de la dirección.
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
  pasos: vi.fn(),
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
vi.mock("@/server/alta/pasos-hechos", () => ({ pasosHechos: m.pasos }));
vi.mock("@/app/(app)/configuracion/numero-actions", () => ({
  pedirCodigoDelNumero: vi.fn(),
  verificarCodigoDelNumero: vi.fn(),
}));
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
import { RESULTADOS_GMAIL } from "@/app/(app)/configuracion/gmail-resultados";
import { PruebaPanel } from "@/app/(app)/configuracion/PruebaPanel";
import { paraAdmin } from "@/app/(app)/configuracion/para-admin";

const TENANT = "10000000-0000-0000-0000-000000000001";
const AHORA = new Date("2026-10-08T12:00:00.000Z");
const VISTA = { webhook_url: "https://core.aseguradora.com.ar/hook", enabled: true };
const falta = (code: string) => Object.assign(new Error("no existe"), { code });
const enDias = (dias: number) => new Date(AHORA.getTime() + dias * 24 * 60 * 60 * 1000).toISOString();

/** Lo que devuelve el lote con la 0048 aplicada. */
function lote(
  tenant: {
    billing_status?: string;
    trial_ends_at?: string | null;
    autoalta?: boolean | null;
    funcion_del_numero?: boolean;
  },
  numeros: Array<{ estado: string }> = []
) {
  return [
    [
      {
        emails: [],
        horas: [],
        montos: null,
        billing_status: "trial",
        trial_ends_at: enDias(12),
        autoalta: true,
        funcion_del_numero: true,
        ...tenant,
      },
    ],
    [VISTA],
    numeros,
  ];
}

/** Las consultas que armó la llamada `llamada` al lote. */
function armadas(llamada: number): Array<{ toSQL: () => { sql: string; params: unknown[] } }> {
  const armar = m.enTenantVarias.mock.calls[llamada][1] as (db: unknown) => ReturnType<typeof armadas>;
  return armar(drizzle(async () => ({ rows: [] })));
}

/** El SQL de la consulta `n` del lote que armó la llamada `llamada`. */
const consulta = (llamada: number, n: number) => armadas(llamada)[n].toSQL();

async function pintar(params: { wa?: string; gmail?: string; primeros?: string } = {}) {
  const { default: Pagina } = await import("@/app/(app)/configuracion/page");
  return renderToStaticMarkup(await Pagina({ searchParams: Promise.resolve(params) }));
}

function conRol(role: string, extra: Record<string, unknown> = { autoalta: true }) {
  m.getSessionContext.mockResolvedValue({ user: { id: "u1", email: "ana@example.com" } });
  m.getUserRow.mockResolvedValue({ id: "u1", tenant_id: TENANT, role, full_name: "Ana", plan: "piloto", ...extra });
}

/** Cuántas veces sale un trozo de HTML: el panel del código tiene que salir una sola vez. */
const veces = (html: string, trozo: string) => html.split(trozo).length - 1;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALTA_NUMERO_AUTOMATICO;
  vi.useFakeTimers({ now: AHORA, toFake: ["Date"] });
  m.listaDelTenant.mockResolvedValue([]);
  m.panelSso.mockRejectedValue(falta("42P01"));
  m.locale.mockResolvedValue("es-AR");
  m.pasos.mockResolvedValue({ whatsapp: true, gmail: true });
  conRol("owner");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ALTA_NUMERO_AUTOMATICO;
});

describe("paraAdmin: la prueba y el número", () => {
  it("las lee en el mismo lote que lo demás: un solo viaje", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    await paraAdmin(TENANT);

    expect(m.enTenantVarias).toHaveBeenCalledOnce();
    expect(armadas(0)).toHaveLength(3);
    expect(consulta(0, 0).sql).toContain('(to_jsonb("tenants".*) ->> \'autoalta\')::boolean');
  });

  it("si la 0049 está aplicada lo pregunta en la misma consulta del espacio, sin tirar si falta", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    await paraAdmin(TENANT);

    expect(consulta(0, 0).sql).toContain(
      "to_regprocedure('public.claimmix_numero_automatico(uuid, uuid, text, text, text, text, inet)') is not null"
    );
  });

  it.each([
    ["en prueba, con la 0049", { billing_status: "trial" }, true],
    ["pagando, con la 0049", { billing_status: "active" }, true],
    ["suspendido", { billing_status: "suspended" }, false],
    ["dado de baja", { billing_status: "churned" }, false],
    ["sin la 0049", { funcion_del_numero: false }, false],
    ["la consulta no trajo si está la 0049", { funcion_del_numero: undefined }, false],
  ])("porCodigo, espacio %s: %s", async (_caso, tenant, esperado) => {
    m.enTenantVarias.mockResolvedValueOnce(lote(tenant));

    expect((await paraAdmin(TENANT)).prueba?.porCodigo).toBe(esperado);
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

describe("/configuracion: los primeros pasos salen de lo que falta conectar", () => {
  const NADA = { whatsapp: false, gmail: false };

  beforeEach(() => {
    m.pasos.mockResolvedValue(NADA);
  });

  it("un admin de un espacio del alta automática sin nada conectado ve conectar Gmail y conectar WhatsApp", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar();

    expect(m.pasos).toHaveBeenCalledWith(TENANT);
    expect(html).toContain("Primeros pasos");
    expect(html).toContain("Conectá la casilla de Gmail");
    expect(html).toContain("Conectar Gmail");
    expect(html).toContain('href="/api/admin/gmail-accounts/connect"');
    expect(html).toContain("Conectar WhatsApp");
    expect(html).toContain('href="#whatsapp"');
    expect(html).toContain('id="whatsapp"');
    expect(html.indexOf("Primeros pasos")).toBeLessThan(html.indexOf("Tu prueba y tu WhatsApp"));
  });

  it("los pasos no llevan número escrito: sobra el que no se muestra", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar();

    expect(html).not.toMatch(/>\s*1\. Conect/);
    expect(html).not.toMatch(/>\s*2\. Conect/);
  });

  it("la lista numera los pasos que faltan: sin los números escritos, los pone la lista", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar();

    expect(html).toMatch(/<ol class="list-decimal [^"]*pl-5"/);
  });

  it("no depende de la dirección: ?primeros=1 o no, sale igual", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));
    const sin = await pintar();
    m.enTenantVarias.mockResolvedValueOnce(lote({}));
    const con = await pintar({ primeros: "1" });
    m.enTenantVarias.mockResolvedValueOnce(lote({}));
    const otro = await pintar({ primeros: "0" });

    expect(sin).toContain("Primeros pasos");
    expect(con).toBe(sin);
    expect(otro).toBe(sin);
  });

  it("con Gmail ya conectado queda sólo el paso del WhatsApp", async () => {
    m.pasos.mockResolvedValue({ whatsapp: false, gmail: true });
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar();

    expect(html).toContain("Primeros pasos");
    expect(html).toContain("Conectar WhatsApp");
    expect(html).not.toContain("Conectar Gmail");
    expect(html).not.toContain('href="/api/admin/gmail-accounts/connect"');
  });

  it("con el WhatsApp ya conectado queda sólo el paso de Gmail", async () => {
    m.pasos.mockResolvedValue({ whatsapp: true, gmail: false });
    m.enTenantVarias.mockResolvedValueOnce(lote({}, [{ estado: "conectado" }]));

    const html = await pintar();

    expect(html).toContain("Primeros pasos");
    expect(html).toContain("Conectar Gmail");
    expect(html).not.toContain("Conectar WhatsApp");
  });

  it("con las dos cosas conectadas no hay sección, ni con ?primeros=1", async () => {
    m.pasos.mockResolvedValue({ whatsapp: true, gmail: true });
    m.enTenantVarias.mockResolvedValueOnce(lote({}, [{ estado: "conectado" }]));

    const html = await pintar({ primeros: "1" });

    expect(html).not.toContain("Primeros pasos");
    expect(html).not.toContain("Conectar WhatsApp");
    expect(html).not.toContain("Conectar Gmail");
  });

  it("en inglés, con los mismos dos pasos", async () => {
    m.locale.mockResolvedValue("en-US");
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar();

    expect(html).toContain("First steps");
    expect(html).toContain("Connect Gmail");
    expect(html).toContain("Connect WhatsApp");
  });

  it.each([false, null, undefined])("un espacio de siempre (autoalta %s) no tiene pasos y no lee qué hay conectado", async (autoalta) => {
    conRol("owner", autoalta === undefined ? {} : { autoalta });
    m.enTenantVarias.mockResolvedValueOnce(lote({ autoalta: false }));

    const html = await pintar({ primeros: "1" });

    expect(html).not.toContain("Primeros pasos");
    expect(html).not.toContain("Conectar WhatsApp");
    expect(m.pasos).not.toHaveBeenCalled();
  });

  it("quien no administra no los ve, y no se lee qué hay conectado", async () => {
    conRol("analyst");

    const html = await pintar({ primeros: "1" });

    expect(html).not.toContain("Primeros pasos");
    expect(html).not.toContain("Conectar Gmail");
    expect(m.pasos).not.toHaveBeenCalled();
  });

  it("sin panel de prueba queda sólo el paso de Gmail: el WhatsApp no tiene dónde conectarse", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ autoalta: false }));

    const html = await pintar();

    expect(html).toContain("Conectar Gmail");
    expect(html).not.toContain("Conectar WhatsApp");
  });

  it("no suma consultas al lote: lo conectado se lee aparte, en control", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    await pintar();

    expect(m.enTenantVarias).toHaveBeenCalledOnce();
    expect(armadas(0)).toHaveLength(3);
    expect(m.pasos).toHaveBeenCalledOnce();
  });

  describe("con el número por código prendido", () => {
    beforeEach(() => {
      process.env.ALTA_NUMERO_AUTOMATICO = "1";
    });

    it("el panel del código vive dentro del paso del WhatsApp, una sola vez y sin botón de bajar", async () => {
      m.enTenantVarias.mockResolvedValueOnce(lote({}));

      const html = await pintar();

      expect(veces(html, 'name="codigo"')).toBe(1);
      expect(veces(html, 'value="SMS"')).toBe(1);
      expect(html).not.toContain('href="#whatsapp"');
      expect(html).not.toContain("Conectar WhatsApp");
      expect(html.indexOf("Conectá tu WhatsApp: cada mensaje")).toBeLessThan(html.indexOf('name="codigo"'));
      expect(html.indexOf('name="codigo"')).toBeLessThan(html.indexOf('id="whatsapp"'));
    });

    it("con el WhatsApp ya conectado el panel queda en la sección de la prueba, una sola vez", async () => {
      m.pasos.mockResolvedValue({ whatsapp: true, gmail: false });
      m.enTenantVarias.mockResolvedValueOnce(lote({}));

      const html = await pintar();

      expect(veces(html, 'name="codigo"')).toBe(1);
      expect(html.indexOf('id="whatsapp"')).toBeLessThan(html.indexOf('name="codigo"'));
    });

    it("con todo conectado el panel queda en la sección de la prueba, una sola vez", async () => {
      m.pasos.mockResolvedValue({ whatsapp: true, gmail: true });
      m.enTenantVarias.mockResolvedValueOnce(lote({}));

      const html = await pintar();

      expect(html).not.toContain("Primeros pasos");
      expect(veces(html, 'name="codigo"')).toBe(1);
    });

    it("sin formularios (número conectado) el aviso de ?wa= queda en la sección de la prueba, no en los pasos", async () => {
      m.pasos.mockResolvedValue({ whatsapp: false, gmail: false });
      m.enTenantVarias.mockResolvedValueOnce(lote({}, [{ estado: "conectado" }]));

      const html = await pintar({ wa: "conectado" });

      expect(veces(html, "Listo: tu WhatsApp quedó conectado.")).toBe(1);
      expect(html).not.toContain('name="codigo"');
      expect(html).toContain('href="#whatsapp"');
    });

    it("el aviso de ?wa=revision sale una sola vez y con los formularios", async () => {
      m.enTenantVarias.mockResolvedValueOnce(lote({}));

      const html = await pintar({ wa: "revision" });

      expect(veces(html, "No pudimos conectarlo desde acá.")).toBe(1);
      expect(veces(html, 'name="codigo"')).toBe(1);
    });

    it("sin la prueba vigente no hay panel ni en los pasos: el botón lleva a «lo conectamos nosotros»", async () => {
      m.enTenantVarias.mockResolvedValueOnce(lote({ trial_ends_at: enDias(-3) }));

      const html = await pintar();

      expect(html).not.toContain('name="codigo"');
      expect(html).toContain('href="#whatsapp"');
      expect(html).toContain("Lo conectamos nosotros y te avisamos.");
    });
  });

  describe("con el número por código apagado", () => {
    it("el paso del WhatsApp sólo lleva a la sección de la prueba, sin formularios", async () => {
      m.enTenantVarias.mockResolvedValueOnce(lote({}));

      const html = await pintar({ wa: "conectado" });

      expect(html).toContain('href="#whatsapp"');
      expect(html).not.toContain('name="codigo"');
      expect(html).not.toContain("Listo: tu WhatsApp quedó conectado.");
    });
  });
});

describe("/configuracion: lo que dejó conectar Gmail", () => {
  const textoEs = (r: string) => (esARServidor as Record<string, string>)[`configuracion.gmail.r.${r}`]!;
  const textoEn = (r: string) => (enUSServidor as Record<string, string>)[`configuracion.gmail.r.${r}`]!;
  const escapado = (texto: string) => texto.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

  beforeEach(() => {
    m.enTenantVarias.mockResolvedValue(lote({}));
  });

  it.each(RESULTADOS_GMAIL)("?gmail=%s dice su texto, en una lista cerrada", async (resultado) => {
    const html = await pintar({ gmail: resultado });

    expect(html).toContain(escapado(textoEs(resultado)));
    expect(html).toContain('role="status"');
  });

  it("el éxito es verde y los demás rojos", async () => {
    const bien = await pintar({ gmail: "connected" });
    const mal = await pintar({ gmail: "mailbox_taken" });

    expect(bien).toContain("border-green-200");
    expect(mal).toContain("border-red-200");
    expect(mal).not.toContain(textoEs("connected"));
  });

  it("al conectar, con todo hecho, ofrece ir a la bandeja", async () => {
    const html = await pintar({ gmail: "connected" });

    expect(html).toContain('href="/bandeja"');
    expect(html).toContain("Ir a la bandeja");
  });

  it("al conectar, si todavía faltan pasos, no manda a la bandeja", async () => {
    m.pasos.mockResolvedValue({ whatsapp: false, gmail: true });

    const html = await pintar({ gmail: "connected" });

    expect(html).toContain(escapado(textoEs("connected")));
    expect(html).not.toContain('href="/bandeja"');
    expect(html).toContain("Primeros pasos");
  });

  it("un error nunca ofrece la bandeja", async () => {
    const html = await pintar({ gmail: "save_failed" });

    expect(html).not.toContain('href="/bandeja"');
  });

  it("un admin de un espacio de siempre también ve el resultado y la bandeja", async () => {
    conRol("admin", { autoalta: false });
    m.enTenantVarias.mockResolvedValue(lote({ autoalta: false }));

    const html = await pintar({ gmail: "connected" });

    expect(html).toContain(escapado(textoEs("connected")));
    expect(html).toContain('href="/bandeja"');
    expect(m.pasos).not.toHaveBeenCalled();
  });

  it.each(["raro", "<script>alert(1)</script>", "", "CONNECTED", "constructor"])("?gmail=%s no muestra aviso ni se refleja", async (gmail) => {
    const html = await pintar({ gmail });

    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("configuracion.gmail.r.");
    for (const resultado of RESULTADOS_GMAIL) expect(html).not.toContain(escapado(textoEs(resultado)));
  });

  it("quien no administra no ve nada de Gmail, ni con ?gmail=", async () => {
    conRol("analyst");

    const html = await pintar({ gmail: "connected" });

    expect(html).not.toContain(escapado(textoEs("connected")));
    expect(html).not.toContain("Ir a la bandeja");
  });

  it("en inglés, en inglés", async () => {
    m.locale.mockResolvedValue("en-US");

    const html = await pintar({ gmail: "connected" });

    expect(html).toContain(escapado(textoEn("connected")));
    expect(html).toContain("Go to the inbox");
    expect(html).not.toContain("Ir a la bandeja");
  });
});

describe("/configuracion con el número por código", () => {
  beforeEach(() => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
  });

  it("pedido y con prueba: pinta los formularios del código y cambia la ayuda", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar();

    expect(html).toContain("Conectá tu WhatsApp");
    expect(html).toContain('name="codigo"');
    expect(html).toContain('value="SMS"');
    expect(html).toContain('value="VOICE"');
    expect(html).toContain("Conectalo vos abajo con un código de WhatsApp. Si no podés, lo conectamos nosotros y te avisamos.");
    expect(html).not.toContain("Lo conectamos nosotros y te avisamos.");
  });

  it("no suma consultas: el lote es el mismo, de tres, en un viaje", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    await pintar({ wa: "codigo_enviado" });

    expect(m.enTenantVarias).toHaveBeenCalledOnce();
    expect(armadas(0)).toHaveLength(3);
  });

  it("con la bandera apagada queda lo de hoy: sin formularios y 'lo conectamos nosotros'", async () => {
    delete process.env.ALTA_NUMERO_AUTOMATICO;
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar({ wa: "conectado" });

    expect(html).not.toContain('name="codigo"');
    expect(html).not.toContain("Conectá tu WhatsApp");
    expect(html).not.toContain("Listo: tu WhatsApp quedó conectado.");
    expect(html).toContain("Lo conectamos nosotros y te avisamos.");
  });

  it.each([
    ["ya está conectado", lote({}, [{ estado: "conectado" }])],
    ["está suspendido", lote({}, [{ estado: "suspendido" }])],
    ["la prueba venció", lote({ trial_ends_at: enDias(-3) })],
    ["no es del alta automática", lote({ autoalta: false })],
    ["el espacio está suspendido (billing)", lote({ billing_status: "suspended", trial_ends_at: null })],
    ["el espacio está dado de baja (billing)", lote({ billing_status: "churned", trial_ends_at: null })],
    ["la 0049 no está aplicada", lote({ funcion_del_numero: false })],
  ])("no pinta los formularios si %s", async (_caso, filas) => {
    m.enTenantVarias.mockResolvedValueOnce(filas);

    const html = await pintar();

    expect(html).not.toContain('name="codigo"');
    expect(html).not.toContain('value="SMS"');
    expect(html).not.toContain("Conectalo vos abajo");
  });

  it("bandera prendida pero sin la 0049: lo de hoy, 'lo conectamos nosotros', ni siquiera con ?wa=", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ funcion_del_numero: false }));

    const html = await pintar({ wa: "revision" });

    expect(html).toContain("Lo conectamos nosotros y te avisamos.");
    expect(html).not.toContain("Conectá tu WhatsApp");
    expect(html).not.toContain("No pudimos conectarlo desde acá.");
    expect(html).not.toContain('name="codigo"');
  });

  it("un espacio suspendido o dado de baja no ve «te avisamos» con formularios: sigue con lo de hoy", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ billing_status: "suspended", trial_ends_at: null }));

    const html = await pintar();

    expect(html).toContain("Lo conectamos nosotros y te avisamos.");
    expect(html).not.toContain("Conectalo vos abajo");
  });

  it("con la prueba vencida la ayuda sigue siendo la de hoy", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ trial_ends_at: enDias(-3) }));

    expect(await pintar()).toContain("Lo conectamos nosotros y te avisamos.");
  });

  it("un espacio que ya paga un plan y sigue con el número pedido también los ve", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({ billing_status: "active" }));

    expect(await pintar()).toContain('name="codigo"');
  });

  it("?wa=conectado muestra el aviso, aunque ya no haya formularios", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}, [{ estado: "conectado" }]));

    const html = await pintar({ wa: "conectado" });

    expect(html).toContain("Listo: tu WhatsApp quedó conectado.");
    expect(html).not.toContain('name="codigo"');
  });

  it("?wa=revision muestra el aviso y deja los formularios para reintentar", async () => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar({ wa: "revision" });

    expect(html).toContain("No pudimos conectarlo desde acá.");
    expect(html).toContain('name="codigo"');
  });

  it.each(["raro", "<script>alert(1)</script>", "", "CONECTADO", "constructor"])("?wa=%s no muestra aviso ni se refleja", async (wa) => {
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar({ wa });

    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("configuracion.numero.r.");
    expect(html).toContain('name="codigo"');
  });

  it("quien no administra no ve nada del número, ni con ?wa=", async () => {
    conRol("analyst");

    const html = await pintar({ wa: "conectado" });

    expect(html).not.toContain("Listo: tu WhatsApp quedó conectado.");
    expect(html).not.toContain('name="codigo"');
  });

  it("en inglés, en inglés", async () => {
    m.locale.mockResolvedValue("en-US");
    m.enTenantVarias.mockResolvedValueOnce(lote({}));

    const html = await pintar({ wa: "codigo_enviado" });

    expect(html).toContain("Connect your WhatsApp");
    expect(html).toContain("We sent the code.");
    expect(html).toContain("Connect it yourself below with a WhatsApp code.");
    expect(html).not.toContain("Pedí el código");
  });
});

describe("PruebaPanel", () => {
  it("no tiene nada que se pueda editar", () => {
    const t = getT("es-AR");
    for (const numero of ["pedido", "conectado", "suspendido"] as const) {
      const html = renderToStaticMarkup(<PruebaPanel prueba={{ dias: 5, numero, porCodigo: true }} t={t} />);
      for (const control of ["<input", "<button", "<form", "<select", "<textarea", "<a "]) expect(html).not.toContain(control);
    }
  });

  it("dice 'queda 1 día' en singular", () => {
    expect(renderToStaticMarkup(<PruebaPanel prueba={{ dias: 1, numero: "pedido", porCodigo: false }} t={getT("es-AR")} />)).toContain(
      "Queda 1 día"
    );
    expect(renderToStaticMarkup(<PruebaPanel prueba={{ dias: 1, numero: "pedido", porCodigo: false }} t={getT("en-US")} />)).toContain(
      "1 day left"
    );
  });

  it("con el número por código prendido, sólo el pedido con prueba vigente manda a conectarlo abajo", () => {
    const t = getT("es-AR");
    const pintarPrueba = (prueba: Parameters<typeof PruebaPanel>[0]["prueba"], automatico: boolean) =>
      renderToStaticMarkup(<PruebaPanel prueba={prueba} t={t} automatico={automatico} />);

    expect(pintarPrueba({ dias: 5, numero: "pedido", porCodigo: true }, true)).toContain("Conectalo vos abajo");
    expect(pintarPrueba({ dias: null, numero: "pedido", porCodigo: true }, true)).toContain("Conectalo vos abajo");
    expect(pintarPrueba({ dias: 5, numero: "pedido", porCodigo: true }, false)).toContain("Lo conectamos nosotros y te avisamos.");
    expect(pintarPrueba({ dias: 0, numero: "pedido", porCodigo: true }, true)).toContain("Lo conectamos nosotros y te avisamos.");
    expect(pintarPrueba({ dias: 5, numero: "suspendido", porCodigo: true }, true)).toContain("Escribinos y lo vemos.");
    expect(pintarPrueba({ dias: 5, numero: "conectado", porCodigo: true }, true)).not.toContain("Conectalo vos abajo");
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
