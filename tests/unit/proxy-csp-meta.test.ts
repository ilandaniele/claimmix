import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: h.getSession } } }));

import { proxy } from "@/proxy";

const ENV = { ...process.env };

/** Lo que devuelve getSession con `returnHeaders`: el usuario y las cookies que renovó. */
function sesion(user: { id: string } | null, ...setCookie: string[]) {
  const headers = new Headers();
  for (const c of setCookie) headers.append("Set-Cookie", c);
  return { headers, response: user && { user } };
}

async function csp(ruta: string): Promise<string> {
  const respuesta = await proxy(new NextRequest(`https://claimmix.example.com${ruta}`));
  return respuesta.headers.get("Content-Security-Policy") ?? "";
}

beforeEach(() => {
  h.getSession.mockResolvedValue(sesion({ id: "u1" }));
});

afterEach(() => {
  process.env = { ...ENV };
});

describe("el proxy y la CSP de Meta", () => {
  it("con la ruta prendida, /conectar-whatsapp abre los orígenes de Facebook", async () => {
    process.env.ALTA_WABA_PROPIA = "1";
    process.env.META_APP_ID = "fake-app-id";
    process.env.META_ES_CONFIG_ID = "fake-config-id";
    process.env.WHATSAPP_APP_SECRET = "fake-app-secret";

    expect(await csp("/conectar-whatsapp")).toContain("https://connect.facebook.net");
  });

  it("en cualquier otra ruta no abre nada, aunque esté prendida", async () => {
    process.env.ALTA_WABA_PROPIA = "1";
    process.env.META_APP_ID = "fake-app-id";
    process.env.META_ES_CONFIG_ID = "fake-config-id";
    process.env.WHATSAPP_APP_SECRET = "fake-app-secret";

    for (const ruta of ["/bandeja", "/preparando", "/configuracion", "/conectar-whatsapp-otra"]) {
      expect(await csp(ruta)).not.toContain("facebook");
    }
  });

  it("con la ruta apagada, /conectar-whatsapp tampoco abre nada", async () => {
    delete process.env.ALTA_WABA_PROPIA;

    expect(await csp("/conectar-whatsapp")).not.toContain("facebook");
  });

  it("sin sesión, el redirect al login lleva la misma CSP y /conectar-whatsapp sigue siendo privada", async () => {
    h.getSession.mockResolvedValue(sesion(null));
    process.env.ALTA_WABA_PROPIA = "1";
    process.env.META_APP_ID = "fake-app-id";
    process.env.META_ES_CONFIG_ID = "fake-config-id";
    process.env.WHATSAPP_APP_SECRET = "fake-app-secret";

    const respuesta = await proxy(new NextRequest("https://claimmix.example.com/conectar-whatsapp"));

    expect(respuesta.status).toBe(307);
    expect(respuesta.headers.get("location")).toContain("/login");
  });

  it("con la app propia el asistente no abre nada de Facebook: no usa el SDK", async () => {
    process.env.ALTA_WABA_PROPIA = "1";
    process.env.ALTA_APP_PROPIA = "1";
    process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.example.com";
    process.env.WHATSAPP_APP_SECRETS_KEY = "fake-secrets-key-1";
    process.env.META_APP_ID = "fake-app-id";
    process.env.META_ES_CONFIG_ID = "fake-config-id";
    process.env.WHATSAPP_APP_SECRET = "fake-app-secret";

    expect(await csp("/conectar-whatsapp/app")).not.toContain("facebook");
  });
});

describe("el proxy y las páginas legales de cada espacio", () => {
  const LEGAL = ["/legal/seguros-del-sur/terminos", "/legal/seguros-del-sur/privacidad", "/legal/seguros-del-sur/borrado"];

  async function pedir(ruta: string) {
    return proxy(new NextRequest(`https://claimmix.example.com${ruta}`));
  }

  it.each(LEGAL)("%s se abre sin sesión: la lee Meta, y quien escribe por WhatsApp", async (ruta) => {
    h.getSession.mockClear();
    h.getSession.mockResolvedValue(sesion(null));

    const respuesta = await pedir(ruta);

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("location")).toBeNull();
    expect(h.getSession).not.toHaveBeenCalled();
  });

  it.each(LEGAL)("%s sale marcada noindex", async (ruta) => {
    expect((await pedir(ruta)).headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it.each(["/privacy", "/terms", "/login"])("%s, que ya era pública, no se marca noindex", async (ruta) => {
    h.getSession.mockResolvedValue(sesion(null));

    expect((await pedir(ruta)).headers.get("X-Robots-Tag")).toBeNull();
  });

  it("la CSP de las páginas legales es la base: sin Facebook, aunque la WABA propia esté prendida", async () => {
    process.env.ALTA_WABA_PROPIA = "1";
    process.env.META_APP_ID = "fake-app-id";
    process.env.META_ES_CONFIG_ID = "fake-config-id";
    process.env.WHATSAPP_APP_SECRET = "fake-app-secret";

    for (const ruta of LEGAL) {
      expect(await csp(ruta)).not.toContain("facebook");
    }
  });

  it("lleva los mismos encabezados de seguridad que el resto", async () => {
    const respuesta = await pedir(LEGAL[0]);

    expect(respuesta.headers.get("Content-Security-Policy")).toContain("default-src");
    expect(respuesta.headers.get("X-Frame-Options")).toBe("DENY");
    expect(respuesta.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(respuesta.headers.get("x-csp-nonce")).toBeTruthy();
  });

  it("la barra final es parte del prefijo: /legal sola y /legales siguen pidiendo sesión", async () => {
    h.getSession.mockResolvedValue(sesion(null));

    for (const ruta of ["/legal", "/legales/x/terminos"]) {
      const respuesta = await pedir(ruta);

      expect(respuesta.status).toBe(307);
      expect(respuesta.headers.get("location")).toContain("/login");
    }
  });
});

describe("el proxy y la caché de la sesión", () => {
  const VIEJA = "better-auth.session_token=fake-token; better-auth.session_data=vieja";
  const NUEVA = "better-auth.session_data=nueva; Path=/; HttpOnly; SameSite=Lax";

  it("la cookie que renueva getSession va al navegador y a la página, con una sola consulta", async () => {
    h.getSession.mockClear();
    h.getSession.mockResolvedValue(sesion({ id: "u1" }, NUEVA));

    const respuesta = await proxy(
      new NextRequest("https://claimmix.example.com/bandeja", { headers: { cookie: VIEJA } })
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.getSetCookie()).toContain(NUEVA);
    expect(respuesta.headers.get("x-middleware-request-cookie")).toContain("better-auth.session_data=nueva");
    expect(respuesta.headers.get("x-middleware-request-cookie")).toContain("better-auth.session_token=fake-token");
    expect(h.getSession).toHaveBeenCalledTimes(1);
    expect(h.getSession).toHaveBeenCalledWith(expect.objectContaining({ returnHeaders: true }));
  });

  it("sin cookie renovada el pedido sigue igual", async () => {
    const respuesta = await proxy(
      new NextRequest("https://claimmix.example.com/bandeja", { headers: { cookie: VIEJA } })
    );

    expect(respuesta.headers.getSetCookie()).toEqual([]);
    expect(respuesta.headers.get("x-middleware-request-cookie")).toBe(VIEJA);
  });

  it("con sesión, el login manda a la bandeja", async () => {
    const respuesta = await proxy(new NextRequest("https://claimmix.example.com/login"));

    expect(respuesta.status).toBe(307);
    expect(new URL(respuesta.headers.get("location")!).pathname).toBe("/bandeja");
  });
});
