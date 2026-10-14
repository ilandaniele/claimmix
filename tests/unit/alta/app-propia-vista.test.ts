/**
 * Lo que la página de la app propia le arma al panel sin ir a Meta: la dirección de cada
 * página legal del cliente (`urlLegal`), lo que P1B le muestra para completar los datos de su app
 * (`legalesDeApp`) y la dirección y la marca del webhook (`webhookDeLaFila`).
 *
 * Son funciones puras sobre la fila. Corren de verdad la marca (`derivar`) y la dirección del
 * webhook (`urlDelWebhookDeApp`); lo demás del módulo no se toca.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { legalesDeApp, urlLegal, webhookDeLaFila } from "@/server/alta/app-propia";
import { derivar } from "@/server/alta/sellado";
import type { FilaDeWaba } from "@/server/alta/waba-propia";

const SITIO = "https://claimmix.example.com";
const SLUG = "abcdefghij012345";
const RUTA = "fake-ruta-0123456789abc";
const SECRETO = "fake-client-app-secret";
const TOKEN = "fake-system-user-token";
const PIN = "654321";
const AHORA = new Date("2026-10-13T12:00:00Z");

const NOMBRES = ["NEXT_PUBLIC_SITE_URL", "BETTER_AUTH_SECRET"];
const sinEntorno = () => NOMBRES.forEach((nombre) => delete process.env[nombre]);

const fila = (extra: Partial<FilaDeWaba> = {}): FilaDeWaba => ({
  estado: "armando",
  falla: null,
  wabaId: null,
  businessId: null,
  phoneNumberId: null,
  numeroTipeado: "+5491112345678",
  numeroMeta: null,
  numeroAceptado: false,
  token: TOKEN,
  pin: PIN,
  nombreEstado: null,
  plantillaEnviadaEn: null,
  numeroEstado: null,
  emailDeContacto: "dueno@example.com",
  nombreDelEspacio: "Aseguradora Sur",
  origen: "app_propia",
  appId: "500000000000001",
  secreto: SECRETO,
  ruta: RUTA,
  webhookAppVerificadoEn: null,
  datosAppEn: null,
  primerMensajeEn: null,
  primeraRespuestaEn: null,
  slugLegal: SLUG,
  razonSocial: "Aseguradora Sur S.A.",
  cuit: "30712345671",
  acuerdoVersion: "2026-10",
  recordatorioEn: null,
  puedeEnviar: null,
  ...extra,
});

beforeEach(() => {
  sinEntorno();
  process.env.NEXT_PUBLIC_SITE_URL = SITIO;
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-key";
});

afterEach(sinEntorno);

describe("urlLegal", () => {
  it.each(["terminos", "privacidad", "borrado"] as const)("arma la dirección de «%s» con el sitio y el slug", (pagina) => {
    expect(urlLegal(SLUG, pagina)).toBe(`${SITIO}/legal/${SLUG}/${pagina}`);
  });

  it.each(["/", "//", "///"])("saca la barra final del sitio (%j)", (barras) => {
    process.env.NEXT_PUBLIC_SITE_URL = SITIO + barras;

    expect(urlLegal(SLUG, "terminos")).toBe(`${SITIO}/legal/${SLUG}/terminos`);
  });

  it("ignora los espacios alrededor del sitio", () => {
    process.env.NEXT_PUBLIC_SITE_URL = `  ${SITIO}  `;

    expect(urlLegal(SLUG, "privacidad")).toBe(`${SITIO}/legal/${SLUG}/privacidad`);
  });

  it("acepta el https con mayúsculas", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "HTTPS://claimmix.example.com";

    expect(urlLegal(SLUG, "borrado")).toBe(`HTTPS://claimmix.example.com/legal/${SLUG}/borrado`);
  });

  it.each([null, ""])("sin slug (%j) no hay dirección", (slug) => {
    expect(urlLegal(slug, "terminos")).toBeNull();
  });

  it.each([
    ["http", "http://claimmix.example.com"],
    ["sin esquema", "claimmix.example.com"],
    ["otro esquema", "ftp://claimmix.example.com"],
    ["sólo el esquema", "https://"],
    ["con espacio tras el esquema", "https:// claimmix.example.com"],
    ["vacío", ""],
    ["en blanco", "   "],
  ])("con el sitio %s no hay dirección: Meta sólo llama a https", (_caso, sitio) => {
    process.env.NEXT_PUBLIC_SITE_URL = sitio;

    expect(urlLegal(SLUG, "terminos")).toBeNull();
  });

  it("sin la variable del sitio no hay dirección", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;

    expect(urlLegal(SLUG, "terminos")).toBeNull();
  });
});

describe("legalesDeApp", () => {
  it("con todo cargado arma las tres direcciones y el contacto", () => {
    expect(legalesDeApp(fila())).toEqual({
      terminos: `${SITIO}/legal/${SLUG}/terminos`,
      privacidad: `${SITIO}/legal/${SLUG}/privacidad`,
      borrado: `${SITIO}/legal/${SLUG}/borrado`,
      contacto: "dueno@example.com",
      listos: false,
    });
  });

  it("`listos` es que los datos legales de la app ya se cargaron solos", () => {
    expect(legalesDeApp(fila({ datosAppEn: AHORA })).listos).toBe(true);
    expect(legalesDeApp(fila({ datosAppEn: null })).listos).toBe(false);
  });

  it("sin slug las tres direcciones son null, y el contacto sigue", () => {
    expect(legalesDeApp(fila({ slugLegal: null }))).toEqual({
      terminos: null,
      privacidad: null,
      borrado: null,
      contacto: "dueno@example.com",
      listos: false,
    });
  });

  it("sin sitio https las direcciones son null aunque haya slug", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";

    const l = legalesDeApp(fila());

    expect([l.terminos, l.privacidad, l.borrado]).toEqual([null, null, null]);
  });

  it("sin correo de contacto, el contacto es null y no un texto vacío", () => {
    expect(legalesDeApp(fila({ emailDeContacto: null })).contacto).toBeNull();
  });

  it("no lleva nada más que esas cinco cosas: ni el CUIT, ni la razón social, ni un secreto", () => {
    const l = legalesDeApp(fila({ datosAppEn: AHORA }));

    expect(Object.keys(l).sort()).toEqual(["borrado", "contacto", "listos", "privacidad", "terminos"]);
    const json = JSON.stringify(l);
    for (const secreto of [SECRETO, TOKEN, PIN, RUTA, "30712345671", "Aseguradora Sur S.A."]) {
      expect(json).not.toContain(secreto);
    }
  });
});

describe("webhookDeLaFila", () => {
  it("arma la dirección con el sitio y la ruta de la fila, y la marca derivada de esa ruta", () => {
    expect(webhookDeLaFila(fila())).toEqual({
      url: `${SITIO}/api/webhooks/whatsapp/app/${RUTA}`,
      verifyToken: derivar("wa-verify-app", RUTA),
    });
  });

  it("la marca es la misma cada vez y cambia con la ruta", () => {
    const una = webhookDeLaFila(fila());
    const otra = webhookDeLaFila(fila({ ruta: "fake-otra-ruta-9876543210" }));

    expect(webhookDeLaFila(fila())?.verifyToken).toBe(una?.verifyToken);
    expect(otra?.verifyToken).not.toBe(una?.verifyToken);
  });

  it("la marca no se parece a ningún secreto de la fila", () => {
    const w = webhookDeLaFila(fila());

    expect(w?.verifyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const secreto of [SECRETO, TOKEN, PIN]) expect(w?.verifyToken).not.toContain(secreto);
  });

  it("sólo devuelve la dirección y la marca", () => {
    expect(Object.keys(webhookDeLaFila(fila()) ?? {}).sort()).toEqual(["url", "verifyToken"]);
  });

  it("saca la barra final del sitio", () => {
    process.env.NEXT_PUBLIC_SITE_URL = `${SITIO}//`;

    expect(webhookDeLaFila(fila())?.url).toBe(`${SITIO}/api/webhooks/whatsapp/app/${RUTA}`);
  });

  it.each([null, ""])("sin ruta (%j) no hay webhook", (ruta) => {
    expect(webhookDeLaFila(fila({ ruta }))).toBeNull();
  });

  it.each(["http://claimmix.example.com", "claimmix.example.com", "https://", ""])(
    "con el sitio %j no hay webhook: Meta sólo llama a https",
    (sitio) => {
      process.env.NEXT_PUBLIC_SITE_URL = sitio;

      expect(webhookDeLaFila(fila())).toBeNull();
    }
  );

  it("sin la clave de la marca no hay webhook, y no rompe la página", () => {
    delete process.env.BETTER_AUTH_SECRET;

    expect(webhookDeLaFila(fila())).toBeNull();
  });
});
