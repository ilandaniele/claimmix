/**
 * /admin/altas: lo que el operador ve de cada alta, sobre todo de los clientes que conectan con su
 * propia app de Meta (origen, App ID, webhook, datos de la app, primer mensaje, primera respuesta,
 * `puede_enviar`, recordatorio y las páginas legales con su botón).
 *
 * Quien no es operador ni llega a la lista; la lista se pinta tal cual la devuelve `listarAltas`
 * (las filas ya vienen armadas, ver `panel-operador.test.ts`) y lo que no existe no se inventa.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  operador: vi.fn(),
  locale: vi.fn(),
  listar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("@/lib/auth/require-operator", () => ({ requireOperator: h.operador }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: h.locale }));
// El aviso de cupo tiene su propio test (arrastra el correo del sistema y el límite de pedidos).
vi.mock("@/server/alta/aviso-operador", () => ({ llegoAlAviso: () => false }));
vi.mock("@/server/alta/panel-operador", () => ({
  DIAS_MAXIMOS_DE_PRUEBA: 90,
  listarAltas: h.listar,
  resultadoDelPanel: (crudo: unknown) => (crudo === "legales_despublicadas" || crudo === "ok" ? crudo : null),
}));
vi.mock("@/app/(app)/admin/altas/actions", () => ({
  activarElInquilino: vi.fn(),
  conectar: vi.fn(),
  darDeBajaElNumero: vi.fn(),
  desvincularLaWaba: vi.fn(),
  despublicarLegales: vi.fn(),
  extenderLaPrueba: vi.fn(),
  reactivarElInquilino: vi.fn(),
  reactivarElNumero: vi.fn(),
  reintentarLaWaba: vi.fn(),
  suspenderElInquilino: vi.fn(),
  suspenderElNumero: vi.fn(),
}));

import AltasPage from "@/app/(app)/admin/altas/page";
import { AppError } from "@/lib/errors";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import type { FilaDeAlta, WabaDeAlta } from "@/server/alta/panel-operador";

const TENANT = "22222222-2222-4222-8222-222222222222";
const NUMERO = "44444444-4444-4444-8444-444444444444";
const APP_ID = "123456789012345";

const es = esARServidor;
const en = enUSServidor;

/** La WABA de un cliente que conecta con su app: la conectada del todo, a la que cada test le quita o le cambia algo. */
const waba = (cambios: Partial<WabaDeAlta> = {}): WabaDeAlta => ({
  estado: "conectada",
  falla: null,
  pasoCancelado: null,
  wabaId: "555000111222",
  businessId: "999000111",
  nombreEstado: "APPROVED",
  plantillaEnviadaEn: "2026-10-08T12:00:00.000Z",
  actualizadoEn: "2026-10-09T01:02:03.000Z",
  origen: "app_propia",
  appId: APP_ID,
  webhookVerificadoEn: "2026-10-09T01:00:00.000Z",
  datosAppEn: "2026-10-09T01:05:00.000Z",
  primerMensajeEn: "2026-10-09T02:00:00.000Z",
  primeraRespuestaEn: "2026-10-09T02:00:30.000Z",
  puedeEnviar: "AVAILABLE",
  recordatorioEn: null,
  legalesPublicadas: true,
  ...cambios,
});

const alta = (cambios: Partial<FilaDeAlta> = {}): FilaDeAlta => ({
  tenantId: TENANT,
  nombre: "Seguros Fake",
  contactEmail: "ana@example.com",
  creadoEn: "2026-10-01T10:00:00.000Z",
  plan: "piloto",
  estadoDeFacturacion: "trial",
  pruebaHasta: "2026-10-15T10:00:00.000Z",
  activadoEn: null,
  numero: { id: NUMERO, e164: "+5491100000000", estado: "conectado", phoneNumberId: "100000000000777", wabaId: "555000111222" },
  waba: waba(),
  numeroEnRevision: false,
  repetidoEn: [],
  ...cambios,
});

const panel = (...altas: FilaDeAlta[]) => ({
  migracionPendiente: false,
  altas,
  creadas24h: altas.length,
  tope: 20,
  demoraDeAlta: { mediana: null, p95: null },
});

async function pintar(r?: string, locale: "es-AR" | "en-US" = "es-AR") {
  h.locale.mockResolvedValue(locale);
  return render(await AltasPage({ searchParams: Promise.resolve(r === undefined ? {} : { r }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.operador.mockResolvedValue({ userRow: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
  h.listar.mockResolvedValue(panel(alta()));
});

afterEach(cleanup);

describe("antes de mostrar nada", () => {
  it("sin sesión va a /login y no lee las altas", async () => {
    h.operador.mockRejectedValue(new AppError("MISSING_SESSION"));

    await expect(pintar()).rejects.toThrow("REDIRECT:/login");
    expect(h.listar).not.toHaveBeenCalled();
  });

  it("sin ser operador va a /bandeja y no lee las altas", async () => {
    h.operador.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    await expect(pintar()).rejects.toThrow("REDIRECT:/bandeja");
    expect(h.listar).not.toHaveBeenCalled();
  });

  it("sin la migración avisa que falta y no pinta la tabla", async () => {
    h.listar.mockResolvedValue({ migracionPendiente: true, altas: [], creadas24h: 0, tope: 20 });

    await pintar();

    expect(screen.getByText(es["migracion.pendiente"])).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("la WABA de la app propia", () => {
  it("muestra el origen, el App ID, el webhook, los datos de la app y los hitos del alta", async () => {
    await pintar();

    expect(screen.getByText(`${es["altas.waba.origen"]}: ${es["altas.waba.origen.app"]}`)).toBeTruthy();
    expect(screen.getByText(`${es["altas.waba.appId"]}: ${APP_ID}`)).toBeTruthy();
    expect(screen.getByText(`${es["altas.waba.webhook"]}: ${es["altas.waba.webhook.verificado"]}`)).toBeTruthy();
    expect(screen.getByText(`${es["altas.waba.datosApp"]}: ${es["altas.waba.datosApp.cargados"]}`)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${es["altas.waba.primerMensaje"]}: \\S`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${es["altas.waba.primeraRespuesta"]}: \\S`))).toBeTruthy();
    expect(screen.queryByText(es["altas.waba.todavia"], { exact: false })).toBeNull();
  });

  it("sin webhook verificado, sin datos, sin primer mensaje ni respuesta lo dice, sin inventar una fecha", async () => {
    h.listar.mockResolvedValue(
      panel(
        alta({
          waba: waba({
            estado: "vinculada",
            webhookVerificadoEn: null,
            datosAppEn: null,
            primerMensajeEn: null,
            primeraRespuestaEn: null,
            puedeEnviar: null,
            legalesPublicadas: false,
          }),
        })
      )
    );

    await pintar();

    expect(screen.getByText(`${es["altas.waba.webhook"]}: ${es["altas.waba.webhook.pendiente"]}`)).toBeTruthy();
    expect(screen.getByText(`${es["altas.waba.datosApp"]}: ${es["altas.waba.datosApp.pendientes"]}`)).toBeTruthy();
    expect(screen.getByText(`${es["altas.waba.primerMensaje"]}: ${es["altas.waba.todavia"]}`)).toBeTruthy();
    expect(screen.getByText(`${es["altas.waba.primeraRespuesta"]}: ${es["altas.waba.todavia"]}`)).toBeTruthy();
  });

  it.each([
    ["AVAILABLE", "altas.waba.puedeEnviar.AVAILABLE"],
    ["LIMITED", "altas.waba.puedeEnviar.LIMITED"],
    ["BLOCKED", "altas.waba.puedeEnviar.BLOCKED"],
  ] as const)("`puede_enviar` %s se muestra con su texto", async (puedeEnviar, clave) => {
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ puedeEnviar }) })));

    await pintar();

    expect(screen.getByText(`${es["altas.waba.puedeEnviar"]}: ${es[clave]}`)).toBeTruthy();
  });

  it("sin `puede_enviar` guardado (o con un valor que Graph no usa) no pinta la línea", async () => {
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ puedeEnviar: null }) })));
    await pintar();
    expect(screen.queryByText(es["altas.waba.puedeEnviar"], { exact: false })).toBeNull();

    cleanup();
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ puedeEnviar: "RARO" }) })));
    await pintar();
    expect(screen.queryByText(es["altas.waba.puedeEnviar"], { exact: false })).toBeNull();
  });

  it("el recordatorio sólo aparece si ya salió", async () => {
    await pintar();
    expect(screen.queryByText(es["altas.waba.recordatorio"], { exact: false })).toBeNull();

    cleanup();
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ estado: "armando", recordatorioEn: "2026-10-10T12:00:00.000Z" }) })));
    await pintar();
    expect(screen.getByText(new RegExp(`^${es["altas.waba.recordatorio"]}: \\S`))).toBeTruthy();
  });

  it("las fallas propias de la app tienen su texto", async () => {
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ estado: "falla", falla: "secreto_invalido" }) })));

    await pintar();

    expect(screen.getByText(es["altas.waba.falla.secreto_invalido"])).toBeTruthy();
  });

  it("una falla que no está en la lista cerrada no se pinta: lo que viene de la base no llega a la pantalla", async () => {
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ estado: "falla", falla: "<script>alert(1)</script>" }) })));

    const { container } = await pintar();

    expect(container.innerHTML).not.toContain("<script>");
    expect(container.innerHTML).not.toContain("alert(1)");
  });

  it("no hay en la pantalla ningún campo del secreto, del token ni de la ruta del webhook", async () => {
    const { container } = await pintar();

    expect(container.innerHTML).not.toMatch(/secreto|token|ruta_webhook|slug/i);
  });
});

describe("las páginas legales", () => {
  it("publicadas: lo dice y ofrece despublicarlas con la casilla de confirmación, en un formulario con el espacio", async () => {
    await pintar();

    expect(screen.getByText(`${es["altas.waba.legales"]}: ${es["altas.waba.legales.publicadas"]}`)).toBeTruthy();
    const boton = screen.getByRole("button", { name: es["altas.legales.despublicar"] });
    const formulario = boton.closest("form") as HTMLFormElement;
    expect(formulario).toBeTruthy();
    expect((formulario.querySelector('input[name="tenant_id"]') as HTMLInputElement).value).toBe(TENANT);
    const casilla = within(formulario).getByRole("checkbox") as HTMLInputElement;
    expect(casilla.name).toBe("confirmo");
    expect(casilla.required).toBe(true);
    expect(within(formulario).getByText(es["altas.legales.confirmo"])).toBeTruthy();
  });

  it("despublicadas: lo dice y no hay nada que despublicar", async () => {
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ legalesPublicadas: false }) })));

    await pintar();

    expect(screen.getByText(`${es["altas.waba.legales"]}: ${es["altas.waba.legales.despublicadas"]}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: es["altas.legales.despublicar"] })).toBeNull();
  });

  it("el cliente de Embedded Signup no tiene páginas legales propias: ni la línea ni el botón", async () => {
    h.listar.mockResolvedValue(panel(alta({ waba: waba({ origen: "embedded_signup", appId: null, legalesPublicadas: false }) })));

    await pintar();

    expect(screen.queryByText(es["altas.waba.legales"], { exact: false })).toBeNull();
    expect(screen.queryByRole("button", { name: es["altas.legales.despublicar"] })).toBeNull();
  });
});

describe("el origen y los botones de cada WABA", () => {
  it("Embedded Signup dice su origen y no muestra lo que sólo tiene la app propia", async () => {
    h.listar.mockResolvedValue(
      panel(
        alta({
          waba: waba({
            origen: "embedded_signup",
            appId: null,
            webhookVerificadoEn: null,
            datosAppEn: null,
            primerMensajeEn: null,
            primeraRespuestaEn: null,
            puedeEnviar: null,
            legalesPublicadas: false,
          }),
        })
      )
    );

    await pintar();

    expect(screen.getByText(`${es["altas.waba.origen"]}: ${es["altas.waba.origen.propia"]}`)).toBeTruthy();
    for (const clave of ["altas.waba.appId", "altas.waba.webhook", "altas.waba.datosApp", "altas.waba.primerMensaje"] as const) {
      expect(screen.queryByText(es[clave], { exact: false }), clave).toBeNull();
    }
  });

  it("sin fila de WABA con una WABA en el número, el origen es la plataforma", async () => {
    h.listar.mockResolvedValue(panel(alta({ waba: null })));

    await pintar();

    expect(screen.getByText(`${es["altas.waba.origen"]}: ${es["altas.waba.origen.plataforma"]}`)).toBeTruthy();
  });

  it("una app que se está armando se puede desvincular, pero no reintentar", async () => {
    h.listar.mockResolvedValue(panel(alta({ numero: null, waba: waba({ estado: "armando", wabaId: null, legalesPublicadas: false }) })));

    await pintar();

    expect(screen.getByText(es["altas.waba.estado.armando"])).toBeTruthy();
    expect(screen.getByRole("button", { name: es["altas.waba.desvincular"] })).toBeTruthy();
    expect(screen.queryByRole("button", { name: es["altas.waba.reintentar"] })).toBeNull();
  });

  it("con la app armándose el operador no conecta el número a mano", async () => {
    h.listar.mockResolvedValue(
      panel(
        alta({
          numero: { id: NUMERO, e164: "+5491100000000", estado: "pedido", phoneNumberId: null, wabaId: null },
          waba: waba({ estado: "armando", wabaId: null }),
        })
      )
    );

    await pintar();

    expect(screen.queryByRole("button", { name: es["altas.conectar.boton"] })).toBeNull();
  });

  it("una WABA conectada sana no ofrece reintentar y sí desvincular", async () => {
    await pintar();

    expect(screen.queryByRole("button", { name: es["altas.waba.reintentar"] })).toBeNull();
    expect(screen.getByRole("button", { name: es["altas.waba.desvincular"] })).toBeTruthy();
  });
});

describe("la demora de las altas", () => {
  const texto = (plantilla: string, mediana: string, p95: string) =>
    plantilla.replace("{mediana}", mediana).replace("{p95}", p95);

  it("muestra la mediana y el p95 de los últimos 30 días", async () => {
    h.listar.mockResolvedValue({ ...panel(alta()), demoraDeAlta: { mediana: 150, p95: 600 } });

    await pintar();

    expect(screen.getByText(texto(es["altas.stat.demora"], "2,5 min", "10 min"))).toBeTruthy();
    expect(screen.getByText(es["altas.stat.demora30d"])).toBeTruthy();
  });

  it("sin altas listas en la ventana muestra un guion, no un cero", async () => {
    await pintar();

    expect(screen.getByText(texto(es["altas.stat.demora"], "—", "—"))).toBeTruthy();
  });

  it("en inglés usa el punto decimal y su texto", async () => {
    h.listar.mockResolvedValue({ ...panel(alta()), demoraDeAlta: { mediana: 150, p95: 600 } });

    await pintar(undefined, "en-US");

    expect(screen.getByText(texto(en["altas.stat.demora"], "2.5 min", "10 min"))).toBeTruthy();
    expect(screen.getByText(en["altas.stat.demora30d"])).toBeTruthy();
  });
});

describe("el resultado de la última acción", () => {
  it("las páginas despublicadas se confirman con su mensaje", async () => {
    await pintar("legales_despublicadas");

    expect(within(screen.getByRole("status")).getByText(es["altas.r.legales_despublicadas"])).toBeTruthy();
  });

  it("un ?r= que no está en la lista cerrada no pinta nada", async () => {
    await pintar("<script>alert(1)</script>");

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("en inglés", () => {
  it("las mismas líneas salen con sus textos en inglés", async () => {
    await pintar(undefined, "en-US");

    expect(screen.getByText(`${en["altas.waba.origen"]}: ${en["altas.waba.origen.app"]}`)).toBeTruthy();
    expect(screen.getByText(`${en["altas.waba.appId"]}: ${APP_ID}`)).toBeTruthy();
    expect(screen.getByText(`${en["altas.waba.webhook"]}: ${en["altas.waba.webhook.verificado"]}`)).toBeTruthy();
    expect(screen.getByText(`${en["altas.waba.puedeEnviar"]}: ${en["altas.waba.puedeEnviar.AVAILABLE"]}`)).toBeTruthy();
    expect(screen.getByText(`${en["altas.waba.legales"]}: ${en["altas.waba.legales.publicadas"]}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: en["altas.legales.despublicar"] })).toBeTruthy();
  });
});
