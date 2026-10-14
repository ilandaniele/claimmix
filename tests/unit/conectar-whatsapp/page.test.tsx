/**
 * /conectar-whatsapp (la página de servidor): a quién le abre la pantalla y a quién
 * lo manda a otro lado, y con qué datos arma el panel.
 *
 * El panel es un doble que muestra lo que recibió: lo que se prueba acá es la página.
 * `metodoDelEspacio`, `vistaInicial` y `enlaceDeAyuda` son los de verdad.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  waba: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ filaDeUsuario: h.fila }));
vi.mock("@/lib/i18n/locale", () => ({
  resolveAccountLocale: async (l?: string | null) => (l === "en-US" ? "en-US" : "es-AR"),
}));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/server/alta/waba-publica", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/alta/waba-publica")>()),
  leerWabaPublica: h.waba,
}));
vi.mock("@/app/conectar-whatsapp/WabaPropiaPanel", () => ({
  WabaPropiaPanel: (props: Record<string, unknown>) => <pre data-testid="panel">{JSON.stringify(props)}</pre>,
}));

import ConectarWhatsappPage, { maxDuration } from "@/app/conectar-whatsapp/page";
import type { WabaPublica } from "@/server/alta/waba-publica";
import { textosDePagina } from "@/lib/i18n";

const BANDERAS = [
  "ALTA_NUMERO_AUTOMATICO",
  "ALTA_WABA_PROPIA",
  "ALTA_APP_PROPIA",
  "NEXT_PUBLIC_SITE_URL",
  "WHATSAPP_APP_SECRETS_KEY",
  "META_APP_ID",
  "META_ES_CONFIG_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "ADMIN_EMAILS",
];
const sinBanderas = () => BANDERAS.forEach((nombre) => delete process.env[nombre]);
const conWabaPropia = () => {
  process.env.ALTA_WABA_PROPIA = "1";
  process.env.META_APP_ID = "fake-app-id";
  process.env.META_ES_CONFIG_ID = "fake-config-id";
  process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
};

const conAppPropia = () => {
  process.env.ALTA_APP_PROPIA = "1";
  process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.example.com";
  process.env.WHATSAPP_APP_SECRETS_KEY = "fake-secrets-key-1";
  process.env.META_APP_ID = "fake-app-id";
  process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
};

const fila = (extra: Record<string, unknown> = {}) => ({
  id: "u-1",
  tenant_id: "t-1",
  role: "owner",
  locale: "es-AR",
  autoalta: true,
  ...extra,
});

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

async function pintar() {
  return render(await ConectarWhatsappPage());
}
const props = () => JSON.parse(screen.getByTestId("panel").textContent ?? "{}");
const redirige = async () => {
  try {
    await ConectarWhatsappPage();
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
  sinBanderas();
  conWabaPropia();
  h.sesion.mockResolvedValue({ user: { id: "u-1", email: "ana@example.com" } });
  h.fila.mockResolvedValue(fila());
  h.waba.mockResolvedValue(lectura());
});

afterEach(() => {
  cleanup();
  sinBanderas();
});

describe("a quién le abre la pantalla", () => {
  it("sin sesión va al login", async () => {
    h.sesion.mockResolvedValue(null);

    expect(await redirige()).toBe("REDIRECT:/login");
    expect(h.waba).not.toHaveBeenCalled();
  });

  it("sin fila de usuario va a «pendiente»", async () => {
    h.fila.mockResolvedValue(undefined);

    expect(await redirige()).toBe("REDIRECT:/pendiente");
  });

  it("un admin de un espacio del alta automática la ve", async () => {
    await pintar();

    expect(screen.getByRole("heading", { name: "Conectá tu WhatsApp" })).toBeInTheDocument();
    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });

  it.each(["owner", "admin"])("el rol %s la ve", async (role) => {
    h.fila.mockResolvedValue(fila({ role }));

    await pintar();

    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });

  it.each(["analyst", "specialist", "viewer"])("el rol %s vuelve a /configuracion", async (role) => {
    h.fila.mockResolvedValue(fila({ role }));

    expect(await redirige()).toBe("REDIRECT:/configuracion");
  });

  it.each([false, null, undefined])("un espacio que no es del alta automática (autoalta %j) vuelve a /configuracion", async (autoalta) => {
    h.fila.mockResolvedValue(fila({ autoalta }));

    expect(await redirige()).toBe("REDIRECT:/configuracion");
  });

  it.each(["ALTA_WABA_PROPIA", "META_APP_ID", "META_ES_CONFIG_ID", "WHATSAPP_APP_SECRET"])("sin %s la ruta no existe para nadie", async (falta) => {
    delete process.env[falta];

    expect(await redirige()).toBe("REDIRECT:/configuracion");
  });

  it("con el camino del código prendido y un número en la plataforma, sigue por ahí", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    h.waba.mockResolvedValue(lectura({ idEnLaPlataforma: true }));

    expect(await redirige()).toBe("REDIRECT:/configuracion");
  });

  it("un cliente conectado por la plataforma no pasa a la WABA propia aunque la bandera se prenda después", async () => {
    h.waba.mockResolvedValue(lectura({ numero: "conectado", idEnLaPlataforma: true }));

    expect(await redirige()).toBe("REDIRECT:/configuracion");
  });

  it("uno conectado por su propia WABA sigue viendo la pantalla: es donde se desconecta", async () => {
    h.waba.mockResolvedValue(lectura({ conWaba: true, estado: "conectada", numero: "conectado", wabaId: "123456789012345" }));

    await pintar();

    expect(props().inicial.vista).toBe("conectado");
  });

  it("si la lectura no contesta (sin la 0051, base caída) la pantalla igual abre desde el principio", async () => {
    h.waba.mockResolvedValue(null);

    await pintar();

    expect(props()).toMatchObject({ nombre: "", numeroTipeado: null, inicial: { vista: "inicio", aviso: null } });
  });
});

describe("cuando le toca la app propia", () => {
  beforeEach(() => {
    sinBanderas();
    conAppPropia();
  });

  it("con sólo la app propia prendida y nada empezado, va a su asistente", async () => {
    expect(await redirige()).toBe("REDIRECT:/conectar-whatsapp/app");
  });

  it("una fila de la app propia, viva, va a su asistente aunque el popup también esté prendido", async () => {
    conWabaPropia();
    h.waba.mockResolvedValue(lectura({ conWaba: true, origen: "app_propia", estado: "armando" }));

    expect(await redirige()).toBe("REDIRECT:/conectar-whatsapp/app");
  });

  it("conectada por la app propia sigue yendo ahí aunque la bandera se apague: es donde se desconecta", async () => {
    delete process.env.ALTA_APP_PROPIA;
    h.waba.mockResolvedValue(lectura({ conWaba: true, origen: "app_propia", estado: "conectada", numero: "conectado" }));

    expect(await redirige()).toBe("REDIRECT:/conectar-whatsapp/app");
  });

  it("con las dos vías prendidas y nada empezado gana el popup: la app propia queda como enlace avanzado", async () => {
    conWabaPropia();

    await pintar();

    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });

  it("un espacio que no es del alta automática vuelve a /configuracion", async () => {
    h.fila.mockResolvedValue(fila({ autoalta: false }));

    expect(await redirige()).toBe("REDIRECT:/configuracion");
  });

  it("sin lo que la vía necesita (la clave de los secretos) no hay camino para nadie", async () => {
    delete process.env.WHATSAPP_APP_SECRETS_KEY;

    expect(await redirige()).toBe("REDIRECT:/configuracion");
  });
});

describe("lo que recibe el panel", () => {
  it("lee la WABA una sola vez, con el espacio de la persona", async () => {
    await pintar();

    expect(h.waba).toHaveBeenCalledOnce();
    expect(h.waba).toHaveBeenCalledWith("t-1");
  });

  it("el nombre del espacio y el número tipeado", async () => {
    await pintar();

    expect(props()).toMatchObject({ locale: "es-AR", nombre: "Aseguradora Sur", numeroTipeado: "+5491100000000" });
  });

  it("la vista de la que arranca sale de lo que dice la base", async () => {
    h.waba.mockResolvedValue(lectura({ conWaba: true, estado: "falta_codigo", conToken: true, wabaId: "123456789012345" }));

    await pintar();

    expect(props().inicial).toEqual({ vista: "codigo", aviso: null, paso: null, numeroMeta: null });
  });

  it("un número conectado se muestra con el que informó Meta", async () => {
    h.waba.mockResolvedValue(
      lectura({ conWaba: true, estado: "conectada", numero: "conectado", numeroMeta: "+541100000001", nombreEstado: "APPROVED", plantilla: true })
    );

    await pintar();

    expect(props().conectado).toEqual({ numero: "+541100000001", nombre: "aprobado", plantilla: true });
  });

  it("sin el número de Meta, el tipeado", async () => {
    h.waba.mockResolvedValue(lectura({ conWaba: true, estado: "conectada", numero: "conectado", numeroMeta: null }));

    await pintar();

    expect(props().conectado.numero).toBe("+5491100000000");
  });

  it("sin nada de la WABA todavía: sin nombre de Meta y sin plantilla", async () => {
    await pintar();

    expect(props().conectado).toEqual({ numero: "+5491100000000", nombre: null, plantilla: false });
  });

  it("en inglés", async () => {
    h.fila.mockResolvedValue(fila({ locale: "en-US" }));

    await pintar();

    expect(screen.getByRole("heading", { name: "Connect your WhatsApp" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(props().locale).toBe("en-US");
    expect(props().textos["waba.continuar"]).toBe("Continue");
  });

  it("los textos del panel viajan como prop, en el idioma de la persona", async () => {
    await pintar();

    expect(props().textos["waba.continuar"]).toBe("Continuar");
  });

  it("no le pasa al panel nada que parezca un secreto", async () => {
    h.waba.mockResolvedValue(lectura({ conWaba: true, estado: "falta_pin", conToken: true, wabaId: "123456789012345" }));

    await pintar();

    // Los textos son rótulos fijos («token», «secreto»): tienen que ser el diccionario tal cual, y el resto no.
    expect(props().textos).toEqual(textosDePagina("es-AR"));
    expect(JSON.stringify({ ...props(), textos: undefined })).not.toMatch(/token|pin_cifrado|secret/i);
  });

  describe("el enlace de ayuda", () => {
    it("sin dirección de operador cargada no hay", async () => {
      await pintar();

      expect(props().ayuda).toBeNull();
    });

    it("con dirección, es un mailto con el espacio y la WABA para no tener que preguntarlos", async () => {
      process.env.ADMIN_EMAILS = " Operador@Example.com , otro@example.com";
      h.waba.mockResolvedValue(lectura({ wabaId: "123456789012345" }));

      await pintar();

      const url = new URL(props().ayuda);
      expect(url.protocol).toBe("mailto:");
      expect(url.pathname).toBe("operador@example.com");
      expect(url.searchParams.get("subject")).toBe("Ayuda para conectar mi WhatsApp");
      expect(url.searchParams.get("body")).toContain("Espacio: t-1");
      expect(url.searchParams.get("body")).toContain("WABA: 123456789012345");
    });

    it("sin WABA todavía, un guion", async () => {
      process.env.ADMIN_EMAILS = "operador@example.com";

      await pintar();

      expect(new URL(props().ayuda).searchParams.get("body")).toContain("WABA: -");
    });

    it("en inglés el correo va en inglés", async () => {
      process.env.ADMIN_EMAILS = "operador@example.com";
      h.fila.mockResolvedValue(fila({ locale: "en-US" }));

      await pintar();

      const url = new URL(props().ayuda);
      expect(url.searchParams.get("subject")).toBe("Help connecting my WhatsApp");
      expect(url.searchParams.get("body")).toContain("Workspace: t-1");
    });
  });
});

describe("el tope de la página", () => {
  it("dura 60 s: conectar encadena varias llamadas a Graph", () => {
    expect(maxDuration).toBe(60);
  });
});
