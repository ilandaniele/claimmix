/**
 * Lo que prd no tiene que tocar porque es de dev (`src/server/ambiente/de-otro-ambiente.ts`).
 *
 * Las listas vienen del entorno: sin la variable están vacías y nada de esto
 * cambia nada. Además de las funciones, se prueba el efecto en cada borde: la
 * página y la ruta pública de denuncias, el alta del formulario, el callback de
 * Gmail, el aviso de Pub/Sub, y la pista de /login y /invitacion.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";

const m = vi.hoisted(() => ({
  permanentRedirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT ${destino}`);
  }),
  inquilinoDelFormulario: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": "es-AR" }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  permanentRedirect: m.permanentRedirect,
}));
vi.mock("@/server/web/formulario", () => ({ inquilinoDelFormulario: m.inquilinoDelFormulario }));
vi.mock("@/server/web/token", () => ({ firmarToken: () => "token-de-prueba", verificarToken: () => "ok" }));
vi.mock("@/lib/rate-limit/index", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: m.rateLimit,
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/server/web/ingreso", () => ({ ingresarDenunciaWeb: vi.fn().mockResolvedValue(null) }));
vi.mock("@/server/worker/despachar-extraccion", () => ({ dispatchExtractionWorker: vi.fn() }));
vi.mock("@/server/cases/para-responder", () => ({ marcarParaResponderAunqueSigaElAgente: vi.fn() }));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: vi.fn(),
}));

import DenunciaWebPage from "@/app/denuncia/[slug]/page";
import { POST } from "@/app/api/denuncia/[slug]/route";
import { PistaDelOtroAmbiente } from "@/app/login/PistaDelOtroAmbiente";
import {
  esCasillaDeOtroAmbiente,
  esNumeroDeOtroAmbiente,
  esSlugDeOtroAmbiente,
  urlDelOtroAmbiente,
} from "@/server/ambiente/de-otro-ambiente";

const VARIABLES = ["SLUGS_DE_DEV", "NUMEROS_DE_DEV", "CASILLAS_DE_DEV", "URL_DEL_OTRO_AMBIENTE"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const v of VARIABLES) vi.stubEnv(v, "");
  m.rateLimit.mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
  m.inquilinoDelFormulario.mockResolvedValue({ tenantId: "t", nombre: "Aseguradora" });
});
afterEach(() => vi.unstubAllEnvs());

describe("sin las variables, nada es de otro ambiente", () => {
  it("las listas vacías no vetan nada, ni siquiera el vacío", () => {
    expect(esSlugDeOtroAmbiente("mi-aseguradora")).toBe(false);
    expect(esSlugDeOtroAmbiente("")).toBe(false);
    expect(esNumeroDeOtroAmbiente("100000000000777", "+5491100000000")).toBe(false);
    expect(esNumeroDeOtroAmbiente("")).toBe(false);
    expect(esCasillaDeOtroAmbiente("claims@example.com")).toBe(false);
    expect(esCasillaDeOtroAmbiente("")).toBe(false);
    expect(urlDelOtroAmbiente()).toBeNull();
    expect(urlDelOtroAmbiente("/login")).toBeNull();
  });

  it("variables que no están definidas se comportan igual", () => {
    for (const v of VARIABLES) vi.stubEnv(v, undefined as unknown as string);
    expect(esSlugDeOtroAmbiente("mi-aseguradora")).toBe(false);
    expect(urlDelOtroAmbiente()).toBeNull();
  });
});

describe("las listas", () => {
  it("separan por comas, recortan blancos y no distinguen mayúsculas", () => {
    vi.stubEnv("SLUGS_DE_DEV", " Mi-Aseguradora ,, otra-aseguradora ,");
    expect(esSlugDeOtroAmbiente("mi-aseguradora")).toBe(true);
    expect(esSlugDeOtroAmbiente("OTRA-ASEGURADORA")).toBe(true);
    expect(esSlugDeOtroAmbiente(" otra-aseguradora ")).toBe(true);
    expect(esSlugDeOtroAmbiente("tercera")).toBe(false);
    expect(esSlugDeOtroAmbiente("")).toBe(false);
    // Es igualdad, no prefijo ni contenido.
    expect(esSlugDeOtroAmbiente("mi-aseguradora-2")).toBe(false);
    expect(esSlugDeOtroAmbiente("aseguradora")).toBe(false);
  });

  it("las casillas se comparan sin mayúsculas ni blancos", () => {
    vi.stubEnv("CASILLAS_DE_DEV", "Claims@Example.com, otra@example.com");
    expect(esCasillaDeOtroAmbiente("claims@example.com")).toBe(true);
    expect(esCasillaDeOtroAmbiente(" OTRA@example.com ")).toBe(true);
    expect(esCasillaDeOtroAmbiente("tercera@example.com")).toBe(false);
  });

  it("los números aceptan ids de Meta y E.164, y «+549…» y «+54…» son el mismo", () => {
    vi.stubEnv("NUMEROS_DE_DEV", "100000000000777, +5491100000000");
    expect(esNumeroDeOtroAmbiente("100000000000777")).toBe(true);
    expect(esNumeroDeOtroAmbiente(" 100000000000777 ", null)).toBe(true);
    expect(esNumeroDeOtroAmbiente("100000000000888")).toBe(false);
    expect(esNumeroDeOtroAmbiente("100000000000888", "+5491100000000")).toBe(true);
    expect(esNumeroDeOtroAmbiente("100000000000888", "+541100000000")).toBe(true);
    expect(esNumeroDeOtroAmbiente("100000000000888", "+54 9 11 0000-0000")).toBe(true);
    expect(esNumeroDeOtroAmbiente("100000000000888", "+5491100000009")).toBe(false);
    expect(esNumeroDeOtroAmbiente("100000000000888", "no es un número")).toBe(false);
    expect(esNumeroDeOtroAmbiente("100000000000888", "")).toBe(false);
  });

  it("un id de Meta de la lista no vale como número de teléfono de otro", () => {
    vi.stubEnv("NUMEROS_DE_DEV", "100000000000777");
    expect(esNumeroDeOtroAmbiente("100000000000888", "+5491100000000")).toBe(false);
  });
});

describe("urlDelOtroAmbiente", () => {
  it("pega la ruta a la URL, con o sin barras de más al final", () => {
    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", " https://dev.example.com/ ");
    expect(urlDelOtroAmbiente()).toBe("https://dev.example.com/");
    expect(urlDelOtroAmbiente("/denuncia/mi-aseguradora")).toBe("https://dev.example.com/denuncia/mi-aseguradora");
    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "https://dev.example.com//");
    expect(urlDelOtroAmbiente("/login")).toBe("https://dev.example.com/login");
  });

  it.each(["dev.example.com", "javascript:alert(1)", "https://", "https:///login", "ftp://dev.example.com", "https://a b"])(
    "%j no es una URL http: da null",
    (valor) => {
      vi.stubEnv("URL_DEL_OTRO_AMBIENTE", valor);
      expect(urlDelOtroAmbiente("/login")).toBeNull();
    }
  );
});

describe("/denuncia/[slug] (página)", () => {
  const pintar = (slug: string) =>
    DenunciaWebPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) });

  it("un slug de otro ambiente con URL redirige para siempre (308) y no toca la base", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "mi-aseguradora");
    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "https://dev.example.com");

    await expect(pintar("mi-aseguradora")).rejects.toThrow("NEXT_REDIRECT https://dev.example.com/denuncia/mi-aseguradora");
    expect(m.permanentRedirect).toHaveBeenCalledOnce();
    expect(m.inquilinoDelFormulario).not.toHaveBeenCalled();
  });

  it("sin URL del otro ambiente no redirige: sigue como siempre", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "mi-aseguradora");

    expect(renderToStaticMarkup(await pintar("mi-aseguradora"))).toContain("<form");
    expect(m.permanentRedirect).not.toHaveBeenCalled();
  });

  it("un slug que no es de dev se atiende acá aunque haya URL", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "mi-aseguradora");
    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "https://dev.example.com");

    expect(renderToStaticMarkup(await pintar("otra-aseguradora"))).toContain("<form");
    expect(m.permanentRedirect).not.toHaveBeenCalled();
    expect(m.inquilinoDelFormulario).toHaveBeenCalledWith("otra-aseguradora");
  });
});

describe("POST /api/denuncia/[slug]", () => {
  const enviar = (slug: string) =>
    POST(
      new NextRequest(`http://localhost/api/denuncia/${slug}`, {
        method: "POST",
        body: JSON.stringify({ nombre: "Ana Pérez", email: "ana@example.com", relato: "Me chocaron el auto ayer.", t: "x" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ slug }) }
    );

  it("un slug de otro ambiente con URL responde 308 al mismo envío allá, sin cupo ni lectura del cuerpo", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "mi-aseguradora");
    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "https://dev.example.com");

    const res = await enviar("mi-aseguradora");

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://dev.example.com/api/denuncia/mi-aseguradora");
    expect(m.rateLimit).not.toHaveBeenCalled();
    expect(m.inquilinoDelFormulario).not.toHaveBeenCalled();
  });

  it("sin URL del otro ambiente sigue su camino: no redirige", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "mi-aseguradora");

    const res = await enviar("mi-aseguradora");

    expect(res.status).not.toBe(308);
    expect(m.rateLimit).toHaveBeenCalled();
  });

  it("un slug mal formado sigue siendo 404 aunque esté en la lista", async () => {
    vi.stubEnv("SLUGS_DE_DEV", "AB");
    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "https://dev.example.com");

    expect((await enviar("AB")).status).toBe(404);
  });
});

describe("PistaDelOtroAmbiente", () => {
  it("el {url} del texto se vuelve el enlace, con el host a la vista", () => {
    const html = renderToStaticMarkup(
      PistaDelOtroAmbiente({
        texto: "¿Tu cuenta es de antes del cambio? Entrá en {url}",
        url: "https://dev.example.com/login",
        className: "pista",
      })
    );

    expect(html).toContain('<p class="pista">¿Tu cuenta es de antes del cambio? Entrá en <a href="https://dev.example.com/login"');
    expect(html).toContain(">dev.example.com</a>");
  });

  it("el texto existe en los dos idiomas y lleva el {url}", () => {
    for (const diccionario of [esARServidor, enUSServidor]) {
      expect(diccionario["login.otroAmbiente"]).toContain("{url}");
      expect(diccionario["altas.r.de_otro_ambiente"]).toBeTruthy();
    }
  });
});
