/**
 * Las banderas de las dos vías de la alta con la WABA del cliente y la regla que decide cuál
 * rige para una fila: una fila viva manda con su origen, sin fila viva manda la bandera de la
 * acción. Es lo que evita que apagar una vía le corte el camino a quien ya lo empezó.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { activaPara, appPropia, faltantesDeAppPropia, urlDelWebhookDeApp, wabaPropia } from "@/server/alta/waba-propia-activa";
import type { OrigenDeWaba } from "@/server/alta/waba-resultados";

const POPUP = { ALTA_WABA_PROPIA: "1", META_APP_ID: "100000000000001", META_ES_CONFIG_ID: "fake-config-id", WHATSAPP_APP_SECRET: "fake-app-secret" };
const APP = {
  ALTA_APP_PROPIA: "1",
  NEXT_PUBLIC_SITE_URL: "https://claimmix.example.com",
  META_APP_ID: "100000000000001",
  WHATSAPP_APP_SECRET: "fake-app-secret",
  WHATSAPP_APP_SECRETS_KEY: "test-app-secrets-key",
};

/** Un entorno limpio: ninguna variable de las que mira este módulo viene del equipo de quien corre el test. */
function entorno(valores: Record<string, string>) {
  for (const nombre of new Set([...Object.keys(POPUP), ...Object.keys(APP), "META_ES_CONFIG_ID"])) vi.stubEnv(nombre, "");
  for (const [nombre, valor] of Object.entries(valores)) vi.stubEnv(nombre, valor);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("wabaPropia", () => {
  it("prendida con la bandera y las tres credenciales de la app de Meta", () => {
    entorno(POPUP);
    expect(wabaPropia()).toBe(true);
  });

  it("apagada por omisión", () => {
    entorno({});
    expect(wabaPropia()).toBe(false);
  });

  it.each(["", "0", "true", "si", " 1", "1 "])("la bandera «%s» no la prende: sólo vale «1» exacto", (valor) => {
    entorno({ ...POPUP, ALTA_WABA_PROPIA: valor });
    expect(wabaPropia()).toBe(false);
  });

  it.each(["META_APP_ID", "META_ES_CONFIG_ID", "WHATSAPP_APP_SECRET"])("sin %s queda apagada: el popup no abriría", (nombre) => {
    entorno({ ...POPUP, [nombre]: "" });
    expect(wabaPropia()).toBe(false);
    entorno({ ...POPUP, [nombre]: "   " });
    expect(wabaPropia()).toBe(false);
  });

  it("no depende de la bandera de la app propia ni de su configuración", () => {
    entorno({ ...POPUP, ALTA_APP_PROPIA: "1" });
    expect(wabaPropia()).toBe(true);
    expect(appPropia()).toBe(false);
  });
});

describe("faltantesDeAppPropia", () => {
  it("con todo cargado no falta nada", () => {
    entorno(APP);
    expect(faltantesDeAppPropia()).toEqual([]);
  });

  it("sin nada faltan los cuatro, por nombre y en orden", () => {
    entorno({});
    expect(faltantesDeAppPropia()).toEqual(["NEXT_PUBLIC_SITE_URL", "META_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_APP_SECRETS_KEY"]);
  });

  it.each(["NEXT_PUBLIC_SITE_URL", "META_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_APP_SECRETS_KEY"])("%s en blanco cuenta como faltante", (nombre) => {
    entorno({ ...APP, [nombre]: "   " });
    expect(faltantesDeAppPropia()).toEqual([nombre]);
  });

  it("devuelve nombres, nunca valores", () => {
    entorno({ ...APP, WHATSAPP_APP_SECRETS_KEY: "" });
    expect(JSON.stringify(faltantesDeAppPropia())).not.toContain(APP.WHATSAPP_APP_SECRET);
  });

  it("no mira la bandera: dice qué falta aunque la vía esté apagada", () => {
    entorno({ ...APP, ALTA_APP_PROPIA: "", META_APP_ID: "" });
    expect(faltantesDeAppPropia()).toEqual(["META_APP_ID"]);
  });

  it("no pide la configuración del popup (META_ES_CONFIG_ID)", () => {
    entorno(APP);
    expect(faltantesDeAppPropia()).not.toContain("META_ES_CONFIG_ID");
  });
});

describe("appPropia", () => {
  it("prendida con la bandera y su configuración completa", () => {
    entorno(APP);
    expect(appPropia()).toBe(true);
  });

  it("apagada por omisión", () => {
    entorno({});
    expect(appPropia()).toBe(false);
  });

  it.each(["", "0", "true", "si", " 1", "1 "])("la bandera «%s» no la prende: sólo vale «1» exacto", (valor) => {
    entorno({ ...APP, ALTA_APP_PROPIA: valor });
    expect(appPropia()).toBe(false);
  });

  it.each(["NEXT_PUBLIC_SITE_URL", "META_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_APP_SECRETS_KEY"])(
    "sin %s queda apagada aunque la bandera esté prendida",
    (nombre) => {
      entorno({ ...APP, [nombre]: "" });
      expect(appPropia()).toBe(false);
    }
  );

  it("no necesita la configuración del popup", () => {
    entorno(APP);
    expect(wabaPropia()).toBe(false);
    expect(appPropia()).toBe(true);
  });
});

describe("activaPara", () => {
  const origenes: (OrigenDeWaba | null)[] = ["app_propia", "embedded_signup", null];
  const vivos = ["armando", "suscripta", "vinculada", "falta_codigo", "falta_pin", "conectada", "falla", "reconectando"];

  describe("con una fila viva decide su origen, sin mirar la bandera de la acción", () => {
    it.each(vivos)("«%s» de la app propia: rige si la app propia está prendida", (estado) => {
      entorno(APP);
      expect(activaPara({ origen: "app_propia", estado }, false)).toBe(true);
      expect(activaPara({ origen: "app_propia", estado }, true)).toBe(true);
    });

    it.each(vivos)("«%s» de la app propia: no rige si la app propia está apagada, aunque la acción la pida", (estado) => {
      entorno({ ...POPUP });
      expect(activaPara({ origen: "app_propia", estado }, true)).toBe(false);
    });

    it.each(vivos)("«%s» del popup de Meta: rige si el popup está prendido", (estado) => {
      entorno(POPUP);
      expect(activaPara({ origen: "embedded_signup", estado }, false)).toBe(true);
    });

    it.each(vivos)("«%s» del popup de Meta: no rige si el popup está apagado, aunque la acción lo pida", (estado) => {
      entorno(APP);
      expect(activaPara({ origen: "embedded_signup", estado }, true)).toBe(false);
    });

    it("una fila sin origen se trata como del popup (el camino de antes de la 0051)", () => {
      entorno(POPUP);
      expect(activaPara({ origen: null, estado: "vinculada" }, false)).toBe(true);
      entorno(APP);
      expect(activaPara({ origen: null, estado: "vinculada" }, true)).toBe(false);
    });

    it("apagar una vía no corta la otra: cada fila sigue con la suya", () => {
      entorno({ ...POPUP, ...APP, ALTA_APP_PROPIA: "" });
      expect(activaPara({ origen: "embedded_signup", estado: "vinculada" }, false)).toBe(true);
      expect(activaPara({ origen: "app_propia", estado: "vinculada" }, true)).toBe(false);
      entorno({ ...APP });
      expect(activaPara({ origen: "app_propia", estado: "vinculada" }, false)).toBe(true);
      expect(activaPara({ origen: "embedded_signup", estado: "vinculada" }, true)).toBe(false);
    });
  });

  describe("sin fila viva decide la bandera de la acción", () => {
    it.each(origenes)("sin fila: la bandera manda (origen %s no importa)", () => {
      entorno({});
      expect(activaPara(null, true)).toBe(true);
      expect(activaPara(null, false)).toBe(false);
    });

    it.each(["cancelada", "revocada"])("una fila «%s» no es viva: la bandera de la acción decide", (estado) => {
      entorno({});
      for (const origen of origenes) {
        expect(activaPara({ origen, estado }, true)).toBe(true);
        expect(activaPara({ origen, estado }, false)).toBe(false);
      }
    });

    it("una fila sin estado no es viva: la bandera de la acción decide", () => {
      entorno({});
      for (const origen of origenes) {
        expect(activaPara({ origen, estado: null }, true)).toBe(true);
        expect(activaPara({ origen, estado: null }, false)).toBe(false);
      }
    });

    it("la bandera de la acción es la que ya trae el llamador (por ejemplo `appPropia()`), no se recalcula acá", () => {
      entorno(APP);
      expect(activaPara(null, appPropia())).toBe(true);
      entorno({});
      expect(activaPara(null, appPropia())).toBe(false);
    });
  });
});

describe("urlDelWebhookDeApp", () => {
  const RUTA = "fake-ruta-0123456789abc";

  it("arma la dirección con el sitio de este ambiente y la ruta del espacio", () => {
    entorno(APP);
    expect(urlDelWebhookDeApp(RUTA)).toBe(`https://claimmix.example.com/api/webhooks/whatsapp/app/${RUTA}`);
  });

  it.each([
    ["una barra al final", "https://claimmix.example.com/"],
    ["varias barras al final", "https://claimmix.example.com///"],
    ["espacios alrededor", "  https://claimmix.example.com  "],
    ["mayúsculas en el esquema", "HTTPS://claimmix.example.com"],
  ])("tolera %s", (_nombre, sitio) => {
    entorno({ ...APP, NEXT_PUBLIC_SITE_URL: sitio });
    expect(urlDelWebhookDeApp(RUTA)?.endsWith(`/api/webhooks/whatsapp/app/${RUTA}`)).toBe(true);
    expect(urlDelWebhookDeApp(RUTA)).not.toContain("//api/");
  });

  it("conserva el puerto y un camino base del sitio", () => {
    entorno({ ...APP, NEXT_PUBLIC_SITE_URL: "https://claimmix.example.com:8443/base/" });
    expect(urlDelWebhookDeApp(RUTA)).toBe(`https://claimmix.example.com:8443/base/api/webhooks/whatsapp/app/${RUTA}`);
  });

  it.each([
    ["http", "http://claimmix.example.com"],
    ["sin esquema", "claimmix.example.com"],
    ["otro esquema", "ftp://claimmix.example.com"],
    ["sólo el esquema", "https://"],
    ["sólo el esquema y barras", "https:///"],
    ["un host con espacios", "https://claimmix example.com"],
    ["vacío", ""],
    ["en blanco", "   "],
  ])("Meta no llama a otra cosa que https: con el sitio %s no hay dirección", (_nombre, sitio) => {
    entorno({ ...APP, NEXT_PUBLIC_SITE_URL: sitio });
    expect(urlDelWebhookDeApp(RUTA)).toBeNull();
  });

  it("sin la variable del sitio no hay dirección", () => {
    entorno({});
    expect(urlDelWebhookDeApp(RUTA)).toBeNull();
  });

  it("no mira la bandera: la dirección se arma aunque la vía esté apagada", () => {
    entorno({ ...APP, ALTA_APP_PROPIA: "" });
    expect(urlDelWebhookDeApp(RUTA)).toBe(`https://claimmix.example.com/api/webhooks/whatsapp/app/${RUTA}`);
  });
});
