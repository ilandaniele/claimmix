/**
 * `WabaPropiaEnlace`: la línea y el botón que llevan a /conectar-whatsapp desde
 * /preparando y /configuracion. Es un componente de servidor asíncrono: se lo llama
 * como función y se pinta el elemento que devuelve.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ waba: vi.fn() }));

vi.mock("server-only", () => ({}));
// Un <Link> deja una marca: así se ve que el enlace NO navega del lado del cliente.
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: (p: Record<string, unknown>) => createElement("a", { "data-next-link": "", ...p }) };
});
vi.mock("@/server/alta/waba-publica", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/alta/waba-publica")>()),
  leerWabaPublica: h.waba,
}));

import { WabaPropiaEnlace } from "@/app/conectar-whatsapp/WabaPropiaEnlace";
import { getT } from "@/lib/i18n";
import type { WabaPublica } from "@/server/alta/waba-publica";

const lectura = (extra: Partial<WabaPublica> = {}): WabaPublica => ({
  conWaba: false,
  idEnLaPlataforma: false,
  nombre: "Aseguradora Sur",
  estado: null,
  origen: null,
  falla: null,
  paso: null,
  wabaId: null,
  numeroMeta: null,
  numeroTipeado: "+5491100000000",
  numeroDistinto: false,
  nombreEstado: null,
  plantilla: false,
  conToken: false,
  numero: "pedido",
  ...extra,
});

const es = getT("es-AR");
const en = getT("en-US");

async function pintar(waba?: WabaPublica | null, t = es) {
  return render(await WabaPropiaEnlace({ tenantId: "t-1", t, waba }));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ADMIN_EMAILS;
  h.waba.mockResolvedValue(null);
});

const PRENDER_APP = {
  ALTA_APP_PROPIA: "1",
  NEXT_PUBLIC_SITE_URL: "https://claimmix.example.com",
  META_APP_ID: "123456789012345",
  WHATSAPP_APP_SECRET: "fake-app-secret-1",
  WHATSAPP_APP_SECRETS_KEY: "fake-secrets-key-1",
};

afterEach(() => {
  cleanup();
  delete process.env.ADMIN_EMAILS;
  for (const nombre of Object.keys(PRENDER_APP)) delete process.env[nombre];
});

describe("cómo cuenta cada momento", () => {
  it.each([
    ["sin nada de la WABA", lectura(), "Conectá el WhatsApp de tu empresa con tu cuenta de Meta. Lleva unos 5 minutos.", "Conectar mi WhatsApp"],
    ["con el código a medias", lectura({ conWaba: true, estado: "falta_codigo", conToken: true }), "Empezaste a conectar tu WhatsApp y falta terminar.", "Seguir conectando"],
    ["cancelada", lectura({ conWaba: true, estado: "cancelada", paso: "permissions" }), "Empezaste a conectar tu WhatsApp y falta terminar.", "Seguir conectando"],
    ["con una falla", lectura({ conWaba: true, estado: "falla", falla: "meta" }), "La conexión de tu WhatsApp no terminó. Podés volver a intentarlo.", "Volver a intentar"],
    ["con la autorización revocada por Meta", lectura({ conWaba: true, estado: "revocada", falla: "token_vencido" }), "La conexión de tu WhatsApp no terminó. Podés volver a intentarlo.", "Volver a intentar"],
    ["desconectada por el propio cliente", lectura({ conWaba: true, estado: "revocada", falla: null }), "Conectá el WhatsApp de tu empresa con tu cuenta de Meta. Lleva unos 5 minutos.", "Conectar mi WhatsApp"],
    ["conectada", lectura({ conWaba: true, estado: "conectada", numero: "conectado" }), "Tu WhatsApp está conectado.", "Ver el estado"],
  ])("%s", async (_caso, waba, estado, boton) => {
    await pintar(waba);

    expect(screen.getByRole("status")).toHaveTextContent(estado);
    expect(screen.getByRole("link", { name: boton })).toHaveAttribute("href", "/conectar-whatsapp");
  });

  it("entra a /conectar-whatsapp con una carga entera: un <Link> dejaría el CSP del documento de antes", async () => {
    await pintar(lectura());

    expect(screen.getByRole("link", { name: "Conectar mi WhatsApp" })).not.toHaveAttribute("data-next-link");
  });

  it("en inglés", async () => {
    await pintar(lectura({ conWaba: true, estado: "conectada", numero: "conectado" }), en);

    expect(screen.getByRole("status")).toHaveTextContent("Your WhatsApp is connected.");
    expect(screen.getByRole("link", { name: "See the status" })).toBeInTheDocument();
  });
});

describe("de dónde sale la lectura", () => {
  it("si quien llama ya la hizo, no se repite", async () => {
    await pintar(lectura({ conWaba: true, estado: "conectada", numero: "conectado" }));

    expect(h.waba).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Tu WhatsApp está conectado.");
  });

  it("si quien llama la hizo y no contestó (null), tampoco: queda el enlace de empezar", async () => {
    await pintar(null);

    expect(h.waba).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Conectar mi WhatsApp" })).toBeInTheDocument();
  });

  it("si no la hizo nadie, la hace con el espacio", async () => {
    h.waba.mockResolvedValue(lectura({ conWaba: true, estado: "falta_pin", conToken: true }));

    await pintar(undefined);

    expect(h.waba).toHaveBeenCalledOnce();
    expect(h.waba).toHaveBeenCalledWith("t-1");
    expect(screen.getByRole("link", { name: "Seguir conectando" })).toBeInTheDocument();
  });

  it("si la lectura propia no contesta, sigue siendo el enlace de empezar", async () => {
    await pintar(undefined);

    expect(screen.getByRole("link", { name: "Conectar mi WhatsApp" })).toBeInTheDocument();
  });
});

describe("la ayuda", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = "operador@example.com";
  });

  it("sólo aparece cuando la conexión falló", async () => {
    await pintar(lectura({ conWaba: true, estado: "falla", falla: "meta", wabaId: "123456789012345" }));

    const ayuda = screen.getByRole("link", { name: "¿Necesitás ayuda? Escribinos" });
    const url = new URL(ayuda.getAttribute("href") ?? "");
    expect(url.pathname).toBe("operador@example.com");
    expect(url.searchParams.get("body")).toContain("WABA: 123456789012345");
    expect(url.searchParams.get("body")).toContain("Espacio: t-1");
  });

  it.each([
    ["sin empezar", lectura()],
    ["en curso", lectura({ conWaba: true, estado: "falta_codigo", conToken: true })],
    ["conectada", lectura({ conWaba: true, estado: "conectada", numero: "conectado" })],
  ])("%s: no hay", async (_caso, waba) => {
    await pintar(waba);

    expect(screen.queryByRole("link", { name: /Necesitás ayuda/ })).toBeNull();
  });

  it("sin dirección de operador cargada, ni en la falla", async () => {
    delete process.env.ADMIN_EMAILS;

    await pintar(lectura({ conWaba: true, estado: "falla", falla: "meta" }));

    expect(screen.queryByRole("link", { name: /Necesitás ayuda/ })).toBeNull();
  });

  it("sin WABA todavía (falla antes de tenerla) el cuerpo lleva un guion", async () => {
    await pintar(lectura({ conWaba: true, estado: "falla", falla: "cupo", wabaId: null }));

    const url = new URL(screen.getByRole("link", { name: "¿Necesitás ayuda? Escribinos" }).getAttribute("href") ?? "");
    expect(url.searchParams.get("body")).toContain("WABA: -");
  });
});

describe("lo que nunca muestra", () => {
  it("ni la WABA ni los ids ni el número: sólo texto del diccionario y el enlace", async () => {
    await pintar(lectura({ conWaba: true, estado: "conectada", numero: "conectado", wabaId: "123456789012345", numeroMeta: "+541100000001" }));

    expect(document.body).not.toHaveTextContent("123456789012345");
    expect(document.body).not.toHaveTextContent("+541100000001");
    expect(document.body).not.toHaveTextContent("+5491100000000");
  });
});

describe("el camino de la app propia (metodo «app»)", () => {
  const deApp = (extra: Partial<WabaPublica> = {}) => lectura({ conWaba: true, origen: "app_propia", ...extra });

  async function pintarApp(waba?: WabaPublica | null, t = es) {
    return render(await WabaPropiaEnlace({ tenantId: "t-1", t, waba, metodo: "app" }));
  }

  it.each([
    ["sin nada", null, "Conectá el WhatsApp de tu empresa con tu propia app de Meta. La primera vez lleva alrededor de media hora.", "Conectar con mi app"],
    ["con la fila de otra vía", lectura({ conWaba: true, origen: "embedded_signup" }), "Conectá el WhatsApp de tu empresa con tu propia app de Meta. La primera vez lleva alrededor de media hora.", "Conectar con mi app"],
    ["armando", deApp({ estado: "armando" }), "Empezaste a conectar tu WhatsApp con tu app y falta terminar.", "Seguir conectando"],
    ["suscripta, a la espera del token", deApp({ estado: "suscripta" }), "Empezaste a conectar tu WhatsApp con tu app y falta terminar.", "Seguir conectando"],
    ["con una falla", deApp({ estado: "falla", falla: "token_vencido" }), "La conexión de tu WhatsApp con tu app necesita que la revises.", "Revisar la conexión"],
    ["conectada", deApp({ estado: "conectada", numero: "conectado" }), "Tu WhatsApp está conectado con tu app.", "Ver el estado"],
    ["suspendida", deApp({ estado: "falta_codigo", numero: "suspendido" }), "Tu WhatsApp está conectado con tu app.", "Ver el estado"],
  ])("%s", async (_caso, waba, estado, boton) => {
    await pintarApp(waba);

    expect(screen.getByRole("status")).toHaveTextContent(estado);
    expect(screen.getByRole("link", { name: boton })).toHaveAttribute("href", "/conectar-whatsapp/app");
  });

  it("lleva con una carga entera, no con un <Link>", async () => {
    await pintarApp(null);

    expect(screen.getByRole("link", { name: "Conectar con mi app" })).not.toHaveAttribute("data-next-link");
  });

  it("en inglés", async () => {
    await pintarApp(deApp({ estado: "conectada", numero: "conectado" }), en);

    expect(screen.getByRole("status")).toHaveTextContent("Your WhatsApp is connected through your app.");
  });

  it("no ofrece el enlace avanzado: ya está en ese camino", async () => {
    Object.assign(process.env, PRENDER_APP);

    await pintarApp(null);

    expect(screen.queryByText(/Facebook Login/)).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("la ayuda de una falla lleva el asunto de la app propia con el nombre del espacio", async () => {
    process.env.ADMIN_EMAILS = "operador@example.com";

    await pintarApp(deApp({ estado: "falla", falla: "token_vencido", wabaId: "123456789012345" }));

    const url = new URL(screen.getByRole("link", { name: "¿Necesitás ayuda? Escribinos" }).getAttribute("href") ?? "");
    expect(url.searchParams.get("subject")).toBe("Alta de WhatsApp con app propia: Aseguradora Sur");
    expect(url.searchParams.get("body")).toContain("WABA: 123456789012345");
  });

  it("la ayuda sólo aparece en la falla", async () => {
    process.env.ADMIN_EMAILS = "operador@example.com";

    await pintarApp(deApp({ estado: "conectada", numero: "conectado" }));

    expect(screen.queryByRole("link", { name: /Necesitás ayuda/ })).toBeNull();
  });
});

describe("el enlace avanzado a la app propia (con el popup)", () => {
  const avanzado = () => screen.queryByRole("link", { name: /Conectalo con tu propia app/ });

  it("con la vía prendida y nada empezado, lo ofrece con una carga entera", async () => {
    Object.assign(process.env, PRENDER_APP);

    await pintar(lectura());

    expect(avanzado()).toHaveAttribute("href", "/conectar-whatsapp/app");
    expect(avanzado()).not.toHaveAttribute("data-next-link");
    expect(screen.getByRole("link", { name: "Conectar mi WhatsApp" })).toHaveAttribute("href", "/conectar-whatsapp");
  });

  it("sin fila tampoco hace falta nada empezado: lo ofrece", async () => {
    Object.assign(process.env, PRENDER_APP);

    await pintar(null);

    expect(avanzado()).toBeInTheDocument();
  });

  it("con la bandera apagada, o con algo sin cargar, no lo ofrece", async () => {
    Object.assign(process.env, PRENDER_APP, { ALTA_APP_PROPIA: "0" });
    await pintar(lectura());
    expect(avanzado()).toBeNull();
    cleanup();

    Object.assign(process.env, PRENDER_APP, { ALTA_APP_PROPIA: "1" });
    delete process.env.WHATSAPP_APP_SECRETS_KEY;
    await pintar(lectura());
    expect(avanzado()).toBeNull();
  });

  it.each([
    ["ya empezó por el popup", lectura({ conWaba: true, origen: "embedded_signup", estado: "falta_codigo", conToken: true })],
    ["ya empezó por la app propia", lectura({ conWaba: true, origen: "app_propia", estado: "armando" })],
  ])("%s: no lo ofrece, no se cambia de camino a mitad", async (_caso, waba) => {
    Object.assign(process.env, PRENDER_APP);

    await pintar(waba);

    expect(avanzado()).toBeNull();
  });
});
