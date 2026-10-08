/**
 * `cm_alta`: lo que escribió la persona en /registro hasta que vuelve de Google.
 *
 * Lo que importa es lo que NO abre: una cookie vencida, adulterada, de otra clave
 * o con datos que /registro nunca habría sellado es una cookie que no existe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  borrar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: h.set, get: h.get, delete: h.borrar }),
}));

import {
  abrirAlta,
  borrarCookieDeAlta,
  COOKIE_DE_ALTA,
  DURACION_DE_LA_COOKIE_MS,
  leerCookieDeAlta,
  ponerCookieDeAlta,
  sellarAlta,
} from "@/server/alta/cookie";

const SECRETO = "fake-secreto-de-la-cookie-de-alta-0123456789";
const AHORA = 1_800_000_000_000;
const V = "aBcDeFgHiJkLmNoPqRsTuV";
const DATOS = {
  empresa: "Seguros del Sur",
  numero: "+5492916426930",
  locale: "es-AR" as const,
  origen: "google" as const,
  v: V,
};

/** Cambia un carácter de un tramo de la cookie por otro distinto. */
function adulterar(valor: string, tramo: number): string {
  const partes = valor.split(".");
  const t = partes[tramo];
  partes[tramo] = (t[0] === "A" ? "B" : "A") + t.slice(1);
  return partes.join(".");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BETTER_AUTH_SECRET = SECRETO;
});

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

describe("sellarAlta y abrirAlta", () => {
  it("lo que se sella se abre igual, con su vencimiento", () => {
    const abierto = abrirAlta(sellarAlta(DATOS, AHORA), AHORA);

    expect(abierto).toEqual({ ...DATOS, exp: AHORA + DURACION_DE_LA_COOKIE_MS });
  });

  it("dura una hora", () => {
    const valor = sellarAlta(DATOS, AHORA);

    expect(abrirAlta(valor, AHORA + DURACION_DE_LA_COOKIE_MS - 1)).not.toBeNull();
    expect(abrirAlta(valor, AHORA + DURACION_DE_LA_COOKIE_MS)).toBeNull();
    expect(abrirAlta(valor, AHORA + 2 * DURACION_DE_LA_COOKIE_MS)).toBeNull();
  });

  it("no deja a la vista ni la empresa ni el número", () => {
    const valor = sellarAlta(DATOS, AHORA);

    expect(valor.startsWith("v1.")).toBe(true);
    for (const tramo of valor.split(".")) {
      expect(Buffer.from(tramo, "base64url").toString("utf8")).not.toMatch(/Seguros|5492916426930/);
    }
  });

  it("sellar dos veces lo mismo da dos valores distintos", () => {
    expect(sellarAlta(DATOS, AHORA)).not.toBe(sellarAlta(DATOS, AHORA));
  });

  it.each([1, 2, 3])("adulterada en el tramo %i da null", (tramo) => {
    expect(abrirAlta(adulterar(sellarAlta(DATOS, AHORA), tramo), AHORA)).toBeNull();
  });

  it("sellada con otra clave da null", () => {
    const valor = sellarAlta(DATOS, AHORA);
    process.env.BETTER_AUTH_SECRET = "fake-otro-secreto-que-no-es-el-de-antes-9876543210";

    expect(abrirAlta(valor, AHORA)).toBeNull();
  });

  it("sin secreto no abre nada, y sellar lanza", () => {
    const valor = sellarAlta(DATOS, AHORA);
    delete process.env.BETTER_AUTH_SECRET;

    expect(abrirAlta(valor, AHORA)).toBeNull();
    expect(() => sellarAlta(DATOS, AHORA)).toThrow("BETTER_AUTH_SECRET");
  });

  it.each([undefined, "", "basura", "v1.a.b", "v2.a.b.c", "a.b.c.d"])("el valor %j da null", (valor) => {
    expect(abrirAlta(valor, AHORA)).toBeNull();
  });

  it("con un tramo de más da null", () => {
    expect(abrirAlta(`${sellarAlta(DATOS, AHORA)}.x`, AHORA)).toBeNull();
  });

  it("con una etiqueta de largo distinto da null", () => {
    const [v, iv, , cifrado] = sellarAlta(DATOS, AHORA).split(".");

    expect(abrirAlta([v, iv, "AAAA", cifrado].join("."), AHORA)).toBeNull();
  });

  it("datos que /registro no habría sellado dan null, aunque abran", () => {
    const sellar = (parcial: Record<string, unknown>) =>
      abrirAlta(sellarAlta({ ...DATOS, ...parcial } as typeof DATOS, AHORA), AHORA);

    expect(sellar({ empresa: "ana@example.com" })).toBeNull();
    expect(sellar({ empresa: "a" })).toBeNull();
    expect(sellar({ numero: "2916426930" })).toBeNull();
    expect(sellar({ numero: "+54 9 291 642 6930" })).toBeNull();
    expect(sellar({ origen: "correo" })).toBeNull();
  });

  it("sin el número al azar del viaje, o con uno que no tiene su forma, da null", () => {
    const sellar = (parcial: Record<string, unknown>) =>
      abrirAlta(sellarAlta({ ...DATOS, ...parcial } as typeof DATOS, AHORA), AHORA);

    expect(sellar({ v: undefined })).toBeNull();
    expect(sellar({ v: "corto" })).toBeNull();
    expect(sellar({ v: `${V}x` })).toBeNull();
    expect(sellar({ v: "aBcDeFgHiJkLmNoPqRs+uV" })).toBeNull();
    expect(sellar({ v: 12 })).toBeNull();
  });

  it("un idioma que no es de la casa cae en el de siempre", () => {
    const abierto = abrirAlta(sellarAlta({ ...DATOS, locale: "fr-FR" as never }, AHORA), AHORA);

    expect(abierto?.locale).toBe("es-AR");
  });

  it("conserva el inglés", () => {
    expect(abrirAlta(sellarAlta({ ...DATOS, locale: "en-US" }, AHORA), AHORA)?.locale).toBe("en-US");
  });
});

describe("las cookies del navegador", () => {
  it("se pone HttpOnly, Secure, Lax, sólo para /alta y por una hora", async () => {
    const { v: _v, ...sinV } = DATOS;
    const v = await ponerCookieDeAlta(sinV);

    expect(h.set).toHaveBeenCalledTimes(1);
    const [nombre, valor, opciones] = h.set.mock.calls[0];
    expect(nombre).toBe(COOKIE_DE_ALTA);
    expect(abrirAlta(valor, Date.now())).toMatchObject({ ...sinV, v });
    expect(opciones).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/alta",
      maxAge: 3600,
    });
  });

  it("cada cookie lleva su propio número al azar, y es el que devuelve", async () => {
    const { v: _v, ...sinV } = DATOS;

    const primero = await ponerCookieDeAlta(sinV);
    const segundo = await ponerCookieDeAlta(sinV);

    expect(primero).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(segundo).not.toBe(primero);
    expect(abrirAlta(h.set.mock.calls[1][1], Date.now())?.v).toBe(segundo);
  });

  it("se lee la que hay, y sin cookie no hay datos", async () => {
    h.get.mockReturnValueOnce({ value: sellarAlta(DATOS) });
    expect(await leerCookieDeAlta()).toMatchObject(DATOS);
    expect(h.get).toHaveBeenCalledWith(COOKIE_DE_ALTA);

    h.get.mockReturnValueOnce(undefined);
    expect(await leerCookieDeAlta()).toBeNull();
  });

  it("una cookie adulterada se lee como si no estuviera", async () => {
    h.get.mockReturnValueOnce({ value: adulterar(sellarAlta(DATOS), 3) });

    expect(await leerCookieDeAlta()).toBeNull();
  });

  it("se borra con el mismo nombre y el mismo camino con que se puso", async () => {
    await borrarCookieDeAlta();

    expect(h.borrar).toHaveBeenCalledWith({ name: COOKIE_DE_ALTA, path: "/alta" });
  });
});
