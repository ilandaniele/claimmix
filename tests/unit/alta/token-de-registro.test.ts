/**
 * El enlace de «Activar tu cuenta»: lo que escribió la persona en /registro hasta
 * que abre el mail.
 *
 * Lo que importa es lo que NO abre: un enlace vencido, adulterado, de otra clave,
 * de otro uso o con datos que /registro nunca habría sellado es un enlace que no
 * existe. Que el correo y el nombre no viajan a la vista. Y que no lleva empresa
 * ni número: la cuenta se crea sola, el espacio se pide después en /alta.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { abrir, sellar } from "@/server/alta/sellado";
import { abrirToken, DURACION_DEL_TOKEN_MS, sellarToken } from "@/server/alta/token-de-registro";

const SECRETO = "fake-secreto-del-enlace-de-alta-0123456789";
const AHORA = 1_800_000_000_000;
const DATOS = {
  e: "ana@example.com",
  nombre: "Ana Pérez",
  locale: "es-AR" as const,
};

/** Lo que sellaba el enlace antes de separar la cuenta del espacio, además de lo de arriba. */
const FORMA_VIEJA = { empresa: "Seguros del Sur", numero: "+5492916426930" };

/** Cambia un carácter de un tramo del enlace por otro distinto. */
function adulterar(valor: string, tramo: number): string {
  const partes = valor.split(".");
  const t = partes[tramo];
  partes[tramo] = (t[0] === "A" ? "B" : "A") + t.slice(1);
  return partes.join(".");
}

/** Un enlace bien sellado con la clave del uso correcto pero con datos que no son los de /registro. */
const sellarDatos = (datos: Record<string, unknown>) =>
  sellar("alta-correo", { ...DATOS, exp: AHORA + DURACION_DEL_TOKEN_MS, ...datos });

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = SECRETO;
});

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

describe("sellarToken y abrirToken", () => {
  it("lo que se sella se abre igual, con su vencimiento", () => {
    expect(abrirToken(sellarToken(DATOS, AHORA), AHORA)).toEqual({
      ...DATOS,
      exp: AHORA + DURACION_DEL_TOKEN_MS,
    });
  });

  it("dura una hora", () => {
    const valor = sellarToken(DATOS, AHORA);

    expect(DURACION_DEL_TOKEN_MS).toBe(60 * 60 * 1000);
    expect(abrirToken(valor, AHORA + DURACION_DEL_TOKEN_MS - 1)).not.toBeNull();
    expect(abrirToken(valor, AHORA + DURACION_DEL_TOKEN_MS)).toBeNull();
    expect(abrirToken(valor, AHORA + 2 * DURACION_DEL_TOKEN_MS)).toBeNull();
  });

  it("abrirlo dos veces da lo mismo: el enlace no se gasta", () => {
    const valor = sellarToken(DATOS, AHORA);

    expect(abrirToken(valor, AHORA)).toEqual(abrirToken(valor, AHORA));
  });

  it("no deja a la vista ni el correo ni el nombre", () => {
    const valor = sellarToken(DATOS, AHORA);

    expect(valor.startsWith("v1.")).toBe(true);
    for (const tramo of valor.split(".")) {
      expect(Buffer.from(tramo, "base64url").toString("utf8")).not.toMatch(/ana@example|Pérez/);
    }
  });

  it("el enlace nuevo no lleva empresa ni número, ni a la vista ni sellados", () => {
    const sellado = abrir("alta-correo", sellarToken(DATOS, AHORA)) as Record<string, unknown>;

    expect(Object.keys(sellado).sort()).toEqual(["e", "exp", "locale", "nombre"]);
  });

  it("es seguro de poner en una URL", () => {
    expect(sellarToken(DATOS, AHORA)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("sellar dos veces lo mismo da dos valores distintos", () => {
    expect(sellarToken(DATOS, AHORA)).not.toBe(sellarToken(DATOS, AHORA));
  });

  it.each([1, 2, 3])("adulterado en el tramo %i da null", (tramo) => {
    expect(abrirToken(adulterar(sellarToken(DATOS, AHORA), tramo), AHORA)).toBeNull();
  });

  it("sellado con otra clave da null", () => {
    const valor = sellarToken(DATOS, AHORA);
    process.env.BETTER_AUTH_SECRET = "fake-otro-secreto-que-no-es-el-de-antes-9876543210";

    expect(abrirToken(valor, AHORA)).toBeNull();
  });

  it("sin secreto no abre nada, y sellar lanza", () => {
    const valor = sellarToken(DATOS, AHORA);
    delete process.env.BETTER_AUTH_SECRET;

    expect(abrirToken(valor, AHORA)).toBeNull();
    expect(() => sellarToken(DATOS, AHORA)).toThrow("BETTER_AUTH_SECRET");
  });

  it("lo sellado para otro uso no abre acá, ni al revés", () => {
    const deOtroUso = sellar("invitacion", { ...DATOS, exp: AHORA + DURACION_DEL_TOKEN_MS });

    expect(abrirToken(deOtroUso, AHORA)).toBeNull();
    expect(abrir("invitacion", sellarToken(DATOS, AHORA))).toBeNull();
  });

  it.each([undefined, null, 42, {}, "", "basura", "v1.a.b", "v2.a.b.c", "a.b.c.d"])(
    "el valor %j da null",
    (valor) => {
      expect(abrirToken(valor, AHORA)).toBeNull();
    }
  );

  it("con un tramo de más da null", () => {
    expect(abrirToken(`${sellarToken(DATOS, AHORA)}.x`, AHORA)).toBeNull();
  });
});

describe("lo que abre tiene la forma que /registro sella", () => {
  it("el sellado a mano con datos buenos abre: la prueba de abajo no falla por el armado", () => {
    expect(abrirToken(sellarDatos({}), AHORA)).not.toBeNull();
  });

  it.each([
    ["sin vencimiento", { exp: undefined }],
    ["con el vencimiento como texto", { exp: String(AHORA + DURACION_DEL_TOKEN_MS) }],
    ["con un correo que no es un correo", { e: "no-es-un-correo" }],
    ["sin correo", { e: undefined }],
    ["con un nombre de una letra", { nombre: "A" }],
    ["sin nombre", { nombre: undefined }],
  ])("%s da null", (_caso, cambio) => {
    expect(abrirToken(sellarDatos(cambio), AHORA)).toBeNull();
  });

  it("un enlace con la forma vieja (empresa y número) abre como sólo cuenta", () => {
    const abierto = abrirToken(sellarDatos(FORMA_VIEJA), AHORA);

    expect(abierto).toEqual({ ...DATOS, exp: AHORA + DURACION_DEL_TOKEN_MS });
    expect(abierto).not.toHaveProperty("empresa");
    expect(abierto).not.toHaveProperty("numero");
  });

  it("claves de más, de cualquier tipo, se descartan y no hacen fallar la apertura", () => {
    const abierto = abrirToken(sellarDatos({ empresa: 42, numero: { x: 1 }, otra: "cosa" }), AHORA);

    expect(abierto).toEqual({ ...DATOS, exp: AHORA + DURACION_DEL_TOKEN_MS });
  });

  it("un idioma que no se soporta cae en el de siempre", () => {
    expect(abrirToken(sellarDatos({ locale: "klingon" }), AHORA)?.locale).toBe("es-AR");
  });

  it("conserva el inglés", () => {
    expect(abrirToken(sellarToken({ ...DATOS, locale: "en-US" }, AHORA), AHORA)?.locale).toBe("en-US");
  });

  it("el correo vuelve en minúsculas y sin espacios", () => {
    expect(abrirToken(sellarDatos({ e: "  Ana@Example.COM " }), AHORA)?.e).toBe("ana@example.com");
  });
});
