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
  lugares: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
  // Como el de Next: lo que corta el render (acá, el redirect) sigue su camino.
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith("REDIRECT:")) throw e;
  },
}));
vi.mock("@/lib/auth/require-operator", () => ({ requireOperator: h.operador }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: h.locale }));
// El aviso de cupo tiene su propio test (arrastra el correo del sistema y el límite de pedidos).
vi.mock("@/server/alta/aviso-operador", () => ({ llegoAlAviso: () => false }));
// El conteo sale de una recorrida de Graph; tiene su propio test.
vi.mock("@/server/alta/lugares-de-la-waba", () => ({ lugaresDeLaWaba: h.lugares }));
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
import { notaDePesos, PLAN_CATALOG, PLANES_COMERCIALES } from "@/lib/billing/plans";
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
  usuariosActivos: 3,
  admin: { nombre: "Ana Pérez", email: "ana@example.com" },
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
  h.lugares.mockResolvedValue({ usados: 1, tope: 2, libres: 1 });
});

afterEach(cleanup);

describe("antes de mostrar nada", () => {
  it("sin sesión va a /login y no lee las altas", async () => {
    h.operador.mockRejectedValue(new AppError("MISSING_SESSION"));

    await expect(pintar()).rejects.toThrow("REDIRECT:/login");
    expect(h.listar).not.toHaveBeenCalled();
    expect(h.lugares).not.toHaveBeenCalled();
  });

  it("sin ser operador va a /bandeja y no lee las altas", async () => {
    h.operador.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    await expect(pintar()).rejects.toThrow("REDIRECT:/bandeja");
    expect(h.listar).not.toHaveBeenCalled();
    expect(h.lugares).not.toHaveBeenCalled();
  });

  it("si la guarda no pudo leer la base no rebota a /bandeja: la falla se muestra", async () => {
    h.operador.mockRejectedValue(new Error("fetch failed"));

    await expect(pintar()).rejects.toThrow("fetch failed");
    expect(h.listar).not.toHaveBeenCalled();
    expect(h.lugares).not.toHaveBeenCalled();
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

describe("los lugares de la WABA de la plataforma", () => {
  const tarjeta = (etiqueta: string) => screen.getByText(etiqueta).closest("div") as HTMLElement;

  it("muestra cuántos lugares libres quedan de cuántos, en español", async () => {
    await pintar();

    expect(screen.getByText("1 libres de 2")).toBeTruthy();
    expect(screen.getByText(es["altas.stat.lugaresWaba"])).toBeTruthy();
    expect(screen.queryByText(es["altas.stat.lugaresSinDato"])).toBeNull();
    expect(tarjeta(es["altas.stat.lugaresWaba"]).className).not.toContain("border-red-300");
  });

  it("y en inglés", async () => {
    await pintar(undefined, "en-US");

    expect(screen.getByText("1 free of 2")).toBeTruthy();
    expect(screen.getByText(en["altas.stat.lugaresWaba"])).toBeTruthy();
  });

  it("lee las dos cosas a la vez, sin otra consulta que la de la lista", async () => {
    await pintar();

    expect(h.listar).toHaveBeenCalledTimes(1);
    expect(h.lugares).toHaveBeenCalledTimes(1);
  });

  it("sin dato de Meta muestra un guion y lo dice, sin inventar un número", async () => {
    h.lugares.mockResolvedValue(null);

    await pintar();

    expect(screen.getByText("—", { selector: "p.text-lg" })).toBeTruthy();
    expect(screen.getByText(es["altas.stat.lugaresSinDato"])).toBeTruthy();
    expect(tarjeta(es["altas.stat.lugaresWaba"]).className).not.toContain("border-red-300");
  });

  it("sin lugares libres la tarjeta va en rojo", async () => {
    h.lugares.mockResolvedValue({ usados: 2, tope: 2, libres: 0 });

    await pintar();

    expect(screen.getByText("0 libres de 2")).toBeTruthy();
    expect(tarjeta(es["altas.stat.lugaresWaba"]).className).toContain("border-red-300");
  });
});

describe("activar un plan", () => {
  const opciones = () =>
    within(screen.getByRole("combobox", { name: es["altas.activar.plan"] }))
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);

  it("ofrece los planes comerciales, con el inicial, y no «piloto»: activarlo daría una Prueba gratis sin vencimiento", async () => {
    await pintar();

    expect(opciones()).toEqual(["inicial", "operativo", "profesional", "corporativo", "enterprise"]);
    expect(opciones()).not.toContain("piloto");
  });

  it("arranca en operativo, no en el inicial", async () => {
    await pintar();

    expect((screen.getByRole("combobox", { name: es["altas.activar.plan"] }) as HTMLSelectElement).value).toBe("operativo");
  });

  it("habla de unidades y de dólares en los tres campos", async () => {
    await pintar();

    expect(screen.getByLabelText("Unidades incluidas")).toBeTruthy();
    expect(screen.getByLabelText("Cuota mensual (US$)")).toBeTruthy();
    expect(screen.getByLabelText("Precio por unidad excedente (US$)")).toBeTruthy();
  });

  it("en inglés también, y el plan inicial sale como Starter", async () => {
    await pintar(undefined, "en-US");

    expect(screen.getByLabelText("Included units")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Starter" })).toBeTruthy();
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

describe("el equipo de cada espacio", () => {
  it("la tabla tiene su columna «Equipo»", async () => {
    await pintar();

    expect(screen.getByRole("columnheader", { name: es["altas.col.equipo"] })).toBeTruthy();
  });

  it("dice cuántas cuentas activas tiene y quién administra, con nombre y correo", async () => {
    await pintar();

    expect(screen.getByText("Usuarios activos: 3")).toBeTruthy();
    expect(screen.getByText("Administra: Ana Pérez · ana@example.com")).toBeTruthy();
    expect(screen.queryByText(es["altas.equipo.sinAdmin"])).toBeNull();
  });

  it("un espacio sin nadie activo muestra 0 y que no tiene administrador, sin inventar uno", async () => {
    h.listar.mockResolvedValue(panel(alta({ usuariosActivos: 0, admin: null })));

    await pintar();

    expect(screen.getByText("Usuarios activos: 0")).toBeTruthy();
    expect(screen.getByText(es["altas.equipo.sinAdmin"])).toBeTruthy();
    expect(screen.queryByText(/^Administra:/)).toBeNull();
  });

  it("un administrador sin nombre sale sólo con su correo, sin separador colgado", async () => {
    h.listar.mockResolvedValue(panel(alta({ admin: { nombre: "", email: "ana@example.com" } })));

    await pintar();

    expect(screen.getByText("Administra: ana@example.com")).toBeTruthy();
  });

  it("un nombre con patrones de reemplazo ($&, $') sale tal cual, no expandido", async () => {
    h.listar.mockResolvedValue(panel(alta({ admin: { nombre: "Ana $& $$", email: "ana$'@example.com" } })));

    await pintar();

    expect(screen.getByText("Administra: Ana $& $$ · ana$'@example.com")).toBeTruthy();
  });

  it("y en inglés", async () => {
    await pintar(undefined, "en-US");

    expect(screen.getByRole("columnheader", { name: en["altas.col.equipo"] })).toBeTruthy();
    expect(screen.getByText("Active users: 3")).toBeTruthy();
    expect(screen.getByText("Admin: Ana Pérez · ana@example.com")).toBeTruthy();
  });

  it("con la tabla vacía el mensaje ocupa las cinco columnas", async () => {
    h.listar.mockResolvedValue(panel());

    const { container } = await pintar();

    expect(container.querySelector("td[colspan]")?.getAttribute("colspan")).toBe("5");
  });
});

describe("el formulario de activar se explica solo", () => {
  /** La app propia también trae su <details>: el del catálogo se busca por su resumen. */
  const catalogo = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("details")).find(
      (d) => d.querySelector("summary")?.textContent === es["altas.activar.catalogo"]
    ) as HTMLDetailsElement;

  /** La ayuda atada al campo por `aria-describedby`: tiene que existir en la página, no sólo en el hover. */
  const ayudaDe = (campo: HTMLElement) => {
    const id = campo.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const ayuda = document.getElementById(id as string);
    expect(ayuda).not.toBeNull();
    return (ayuda as HTMLElement).textContent;
  };

  it.each([
    ["altas.activar.plan", "altas.activar.ayudaPlan"],
    ["altas.activar.cuota", "altas.activar.ayudaCuota"],
    ["altas.activar.excedente", "altas.activar.ayudaExcedente"],
  ] as const)("el campo «%s» muestra su ayuda, atada con aria-describedby y repetida en el title", async (campo, ayuda) => {
    await pintar();

    const control = screen.getByLabelText(es[campo]);
    expect(ayudaDe(control)).toBe(es[ayuda]);
    expect(control.getAttribute("title")).toBe(es[ayuda]);
    expect(screen.getByText(es[ayuda])).toBeTruthy();
  });

  it("las unidades incluidas explican el peso de cada canal con las constantes que se aplican de verdad", async () => {
    await pintar();

    const control = screen.getByLabelText(es["altas.activar.incluidas"]);
    const ayuda = ayudaDe(control) as string;
    expect(ayuda).toBe(notaDePesos(es["altas.activar.ayudaIncluidas"], String));
    expect(ayuda).toContain("1 por WhatsApp");
    expect(ayuda).toContain("0.8 por WhatsApp de su WABA propia");
    expect(ayuda).toContain("0.5 por mail");
    expect(ayuda).not.toMatch(/[{}]/);
    expect(control.getAttribute("title")).toBe(ayuda);
  });

  it("los pesos de la ayuda salen con punto: es lo que el campo acepta, no la coma de la factura", async () => {
    await pintar();

    expect(ayudaDe(screen.getByLabelText(es["altas.activar.incluidas"]))).not.toMatch(/\d,\d/);
  });

  it("en inglés la ayuda y los pesos salen en inglés", async () => {
    await pintar(undefined, "en-US");

    const ayuda = ayudaDe(screen.getByLabelText(en["altas.activar.incluidas"]));
    expect(ayuda).toBe(notaDePesos(en["altas.activar.ayudaIncluidas"], String));
    expect(ayuda).toContain("0.8 by WhatsApp on its own WABA");
    expect(ayudaDe(screen.getByLabelText(en["altas.activar.cuota"]))).toBe(en["altas.activar.ayudaCuota"]);
  });

  it.each([
    ["es-AR", es, /Vacío = .* 0 = sin cuota/, /Vacío = .* 0 = no se cobra/, /Vacío = .* 0 = ninguna/, /catálogo/],
    ["en-US", en, /Empty = .* 0 = no fee/, /Empty = .* 0 = not charged/, /Empty = .* 0 = none/, /catalog/],
  ] as const)(
    "en %s la ayuda distingue vacío (el valor del plan) de 0 y dice de dónde salen los valores del plan",
    async (locale, textos, cuota, excedente, incluidas, catalogoDelPlan) => {
      await pintar(undefined, locale);

      const ayuda = (clave: keyof typeof es) => ayudaDe(screen.getByLabelText(textos[clave]));
      expect(ayuda("altas.activar.cuota")).toMatch(cuota);
      expect(ayuda("altas.activar.excedente")).toMatch(excedente);
      expect(ayuda("altas.activar.incluidas")).toMatch(incluidas);
      expect(ayuda("altas.activar.plan")).toMatch(catalogoDelPlan);
      expect(textos["altas.activar.ayuda"]).toMatch(/ 0 /);
    }
  );

  it("la ayuda general está en frases cortas y avisa lo del punto decimal y el piloto guiado", async () => {
    await pintar();

    const ayuda = screen.getByText(es["altas.activar.ayuda"]);
    expect(ayuda).toBeTruthy();
    expect(es["altas.activar.ayuda"]).toContain("punto");
    expect(es["altas.activar.ayuda"]).toContain("Piloto guiado");
    for (const frase of es["altas.activar.ayuda"].split(". ")) expect(frase.split(" ").length).toBeLessThanOrEqual(20);
  });

  it("el catálogo es un <details> cerrado con un renglón por plan comercial y los importes como se tipean", async () => {
    const { container } = await pintar();

    const detalle = catalogo(container);
    expect(detalle.open).toBe(false);

    const filas = Array.from(detalle.querySelectorAll("table > tbody > tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent)
    );
    expect(filas.map((f) => f.slice(1))).toEqual(
      PLANES_COMERCIALES.map((plan) => [
        `US$ ${PLAN_CATALOG[plan].monthly_fee_usd}`,
        String(PLAN_CATALOG[plan].included_claims),
        `US$ ${PLAN_CATALOG[plan].overage_price_usd}`,
      ])
    );
    expect(filas.map((f) => f[0]).every(Boolean)).toBe(true);
    for (const [, cuota, , excedente] of filas) {
      // «US$ 1100» y «US$ 1.5»: sin separador de miles ni coma, porque el campo guardaría «1.100» como 1,1 y rechazaría «1,5».
      expect(cuota).toMatch(/^US\$ \d+(\.\d+)?$/);
      expect(excedente).toMatch(/^US\$ \d+(\.\d+)?$/);
    }
  });

  it("el catálogo no ofrece «piloto»", async () => {
    const { container } = await pintar();

    expect(catalogo(container).querySelectorAll("table > tbody > tr")).toHaveLength(PLANES_COMERCIALES.length);
    expect(catalogo(container).textContent).not.toMatch(/piloto/i);
  });

  it("con dos filas los ids de las ayudas no se repiten", async () => {
    h.listar.mockResolvedValue(
      panel(alta(), alta({ tenantId: "33333333-3333-4333-8333-333333333333", nombre: "Otra Fake" }))
    );

    const { container } = await pintar();

    const ids = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ["es-AR", es],
    ["en-US", en],
  ] as const)("«Activar plan» es un grupo con nombre, y la ayuda de qué completar va antes de los campos (%s)", async (locale, d) => {
    await pintar(undefined, locale);

    const grupo = screen.getByRole("group", { name: d["altas.activar.titulo"] });
    const q = within(grupo);
    const combo = q.getByRole("combobox", { name: d["altas.activar.plan"] });
    expect(q.getByLabelText(d["altas.activar.cuota"])).toBeTruthy();
    expect(q.getByLabelText(d["altas.activar.incluidas"])).toBeTruthy();
    expect(q.getByLabelText(d["altas.activar.excedente"])).toBeTruthy();
    expect(q.getByRole("button", { name: d["altas.activar.boton"] })).toBeTruthy();

    const ayuda = q.getByText(d["altas.activar.ayuda"]);
    expect(ayuda.compareDocumentPosition(combo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("el título del grupo se distingue de la etiqueta de sus campos", async () => {
    await pintar();

    const titulo = screen.getByRole("group", { name: es["altas.activar.titulo"] }).querySelector("legend") as HTMLElement;
    const etiqueta = screen.getByText(es["altas.activar.plan"], { selector: "label" });
    expect(titulo.className).not.toBe(etiqueta.className);
    expect(titulo.className).toContain("font-semibold");
  });

  it("con dos filas hay un grupo de activar por fila", async () => {
    h.listar.mockResolvedValue(
      panel(alta(), alta({ tenantId: "33333333-3333-4333-8333-333333333333", nombre: "Otra Fake" }))
    );

    await pintar();

    expect(screen.getAllByRole("group", { name: es["altas.activar.titulo"] })).toHaveLength(2);
  });

  it("no cambia lo que el formulario manda: mismos nombres de campo y el plan sigue en operativo", async () => {
    const { container } = await pintar();

    const form = container.querySelector("form input[name=cuota]")?.closest("form") as HTMLFormElement;
    expect(Array.from(form.elements).map((e) => (e as HTMLInputElement).name).filter(Boolean)).toEqual([
      "tenant_id",
      "plan",
      "cuota",
      "incluidas",
      "excedente",
    ]);
    expect((screen.getByLabelText(es["altas.activar.plan"]) as HTMLSelectElement).value).toBe("operativo");
  });
});

describe("conectar el número se explica solo", () => {
  const pedido = () =>
    alta({
      numero: { id: NUMERO, e164: "+5491100000000", estado: "pedido", phoneNumberId: null, wabaId: null },
      waba: null,
    });

  it("cada campo trae su ayuda a la vista, atada con aria-describedby", async () => {
    h.listar.mockResolvedValue(panel(pedido()));

    await pintar();

    for (const [campo, ayuda] of [
      [screen.getByLabelText(es["altas.numero.phoneNumberId"]), es["altas.conectar.ayudaPhoneNumberId"]],
      [screen.getByLabelText(es["altas.numero.waba"]), es["altas.conectar.ayudaWaba"]],
    ] as const) {
      const id = campo.getAttribute("aria-describedby") as string;
      expect(document.getElementById(id)?.textContent).toBe(ayuda);
      expect(campo.getAttribute("title")).toBe(ayuda);
    }
  });

  it("«Conectar el número» es un grupo con nombre que junta sus controles", async () => {
    h.listar.mockResolvedValue(panel(pedido()));

    await pintar();

    const q = within(screen.getByRole("group", { name: es["altas.conectar.titulo"] }));
    expect(q.getByLabelText(es["altas.numero.phoneNumberId"])).toBeTruthy();
    expect(q.getByLabelText(es["altas.numero.waba"])).toBeTruthy();
    expect(q.getByRole("checkbox")).toBeTruthy();
    expect(q.getByRole("button", { name: es["altas.conectar.boton"] })).toBeTruthy();
  });

  it("la casilla de confirmación explica de dónde sale el código", async () => {
    h.listar.mockResolvedValue(panel(pedido()));

    await pintar();

    const casilla = screen.getByRole("checkbox");
    expect(document.getElementById(casilla.getAttribute("aria-describedby") as string)?.textContent).toBe(
      es["altas.conectar.ayudaConfirmo"]
    );
  });

  it("sigue pidiendo sólo dígitos y los dos ids", async () => {
    h.listar.mockResolvedValue(panel(pedido()));

    await pintar();

    for (const nombre of [es["altas.numero.phoneNumberId"], es["altas.numero.waba"]]) {
      const campo = screen.getByLabelText(nombre) as HTMLInputElement;
      expect(campo.required).toBe(true);
      expect(campo.getAttribute("pattern")).toBeTruthy();
    }
  });

  it("en inglés también", async () => {
    h.listar.mockResolvedValue(panel(pedido()));

    await pintar(undefined, "en-US");

    const campo = screen.getByLabelText(en["altas.numero.phoneNumberId"]);
    expect(document.getElementById(campo.getAttribute("aria-describedby") as string)?.textContent).toBe(
      en["altas.conectar.ayudaPhoneNumberId"]
    );
  });
});

describe("los textos nuevos del panel", () => {
  const claves = Object.keys(es).filter((k) =>
    /^altas\.(equipo\.|activar\.(ayuda|catalogo)|conectar\.ayuda)/.test(k)
  ) as (keyof typeof es)[];

  it("están todos, en los dos idiomas", () => {
    expect(claves.length).toBeGreaterThanOrEqual(13);
    for (const k of claves) expect(en[k as keyof typeof en]).toBeTruthy();
  });

  it("no dicen token, secreto, slug ni ruta_webhook, y no traen ningún id de Meta", () => {
    for (const k of claves) {
      for (const texto of [es[k], en[k as keyof typeof en]]) {
        expect(texto, k).not.toMatch(/token|secreto|secret|slug|ruta_webhook/i);
        expect(texto, k).not.toMatch(/\d{9,}/);
      }
    }
  });
});
