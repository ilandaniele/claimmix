/**
 * Lo que se le pide a quien crea su espacio: la empresa y el WhatsApp.
 *
 * Las reglas de la empresa son las que revisa la función de la base (0048); si
 * una cambia, la otra tiene que cambiar.
 */

import { describe, expect, it } from "vitest";

import {
  ERRORES_DE_ALTA,
  EMPRESA_MAXIMA,
  faltaElNueveArgentino,
  mismoNumero,
  normalizarE164,
  validarEmpresa,
} from "@/server/alta/validar";

const SEPARADOR_DE_LINEA = String.fromCharCode(0x2028);
const SEPARADOR_DE_PARRAFO = String.fromCharCode(0x2029);

describe("validarEmpresa", () => {
  it("recorta y devuelve el nombre", () => {
    expect(validarEmpresa("  Seguros del Sur S.A.  ")).toEqual({ ok: true, empresa: "Seguros del Sur S.A." });
  });

  it("acepta el mínimo y el máximo", () => {
    expect(validarEmpresa("ab").ok).toBe(true);
    expect(validarEmpresa("a".repeat(EMPRESA_MAXIMA)).ok).toBe(true);
  });

  it("rechaza uno de menos y uno de más", () => {
    expect(validarEmpresa("a").ok).toBe(false);
    expect(validarEmpresa(" a ").ok).toBe(false);
    expect(validarEmpresa("a".repeat(EMPRESA_MAXIMA + 1)).ok).toBe(false);
  });

  it("cuenta caracteres y no unidades UTF-16", () => {
    expect(validarEmpresa("🚗".repeat(EMPRESA_MAXIMA)).ok).toBe(true);
    expect(validarEmpresa("🚗".repeat(EMPRESA_MAXIMA + 1)).ok).toBe(false);
  });

  it("rechaza lo que no es texto", () => {
    for (const crudo of [null, undefined, 42, {}, ["Acme"]]) {
      expect(validarEmpresa(crudo).ok).toBe(false);
    }
  });

  it.each(["Acme https://example.com", "ftp://example.com", "www.example.com", "WWW.Example.com", "ana@example.com"])(
    "rechaza una URL o un correo pegados: %s",
    (crudo) => {
      expect(validarEmpresa(crudo).ok).toBe(false);
    }
  );

  it("rechaza caracteres de control y separadores de línea", () => {
    for (const crudo of [
      "Acme\nSur",
      "Acme\tSur",
      "Acme" + String.fromCharCode(0) + "Sur",
      "Acme" + String.fromCharCode(0x7f) + "Sur",
      "Acme" + String.fromCharCode(0x85) + "Sur",
      `Acme${SEPARADOR_DE_LINEA}Sur`,
      `Acme${SEPARADOR_DE_PARRAFO}Sur`,
    ]) {
      expect(validarEmpresa(crudo).ok).toBe(false);
    }
  });
});

describe("normalizarE164", () => {
  it.each([
    ["+54 9 (291) 642-6930", "+5492916426930"],
    ["+5492916426930", "+5492916426930"],
    ["0054 9 291 642 6930", "+5492916426930"],
    ["  +1 202-555-0123 ", "+12025550123"],
  ])("%s da %s", (crudo, esperado) => {
    expect(normalizarE164(crudo)).toBe(esperado);
  });

  it.each([
    "",
    "291 642 6930",
    "5492916426930",
    "+0123456789",
    "+123456",
    "+1234567890123456",
    "+54 9 29x 642 6930",
    "+54 9 291 642 6930 ext 1",
  ])("no adivina un país que no está: %s", (crudo) => {
    expect(normalizarE164(crudo)).toBeNull();
  });

  it("devuelve null con lo que no es texto", () => {
    expect(normalizarE164(undefined)).toBeNull();
    expect(normalizarE164(5492916426930)).toBeNull();
  });

  it("acepta el largo mínimo y el máximo de un E.164", () => {
    expect(normalizarE164("+12345678")).toBe("+12345678");
    expect(normalizarE164("+123456789012345")).toBe("+123456789012345");
  });
});

describe("mismoNumero", () => {
  it("el celular argentino con 9 y sin 9 es el mismo", () => {
    expect(mismoNumero("+54 9 291 642 6930", "+54 291 642 6930")).toBe(true);
    expect(mismoNumero("+542916426930", "+5492916426930")).toBe(true);
  });

  it("escrito de otra forma sigue siendo el mismo", () => {
    expect(mismoNumero("0054 9 (291) 642-6930", "+5492916426930")).toBe(true);
  });

  it("números distintos no lo son", () => {
    expect(mismoNumero("+5492916426930", "+5492916426931")).toBe(false);
    expect(mismoNumero("+12025550123", "+442025550123")).toBe(false);
  });

  it("un número ilegible no es igual a nada, ni a otro ilegible", () => {
    expect(mismoNumero("hola", "hola")).toBe(false);
    expect(mismoNumero("hola", "+5492916426930")).toBe(false);
    expect(mismoNumero(undefined, undefined)).toBe(false);
  });
});

describe("faltaElNueveArgentino", () => {
  it.each(["+541112345678", "+541123456789", "+541100000000"])("un +54 de diez dígitos sin el 9 falta: %s", (e164) => {
    expect(faltaElNueveArgentino(e164)).toBe(true);
  });

  it.each(["+5492916426930", "+5491123456789"])("con el 9 no falta nada: %s", (e164) => {
    expect(faltaElNueveArgentino(e164)).toBe(false);
  });

  it.each(["+12025550123", "+442025550123", "+54911000000", "+54110000000", "+5411000000001"])(
    "otros países y otros largos quedan como siempre: %s",
    (e164) => {
      expect(faltaElNueveArgentino(e164)).toBe(false);
    },
  );

  it("es lo que saca normalizarE164 de lo que escribe la gente, que no lo cambia", () => {
    expect(normalizarE164("+54 11 1234 5678")).toBe("+541112345678");
    expect(faltaElNueveArgentino(normalizarE164("+54 11 1234-5678")!)).toBe(true);
    expect(faltaElNueveArgentino(normalizarE164("+54 9 11 1234-5678")!)).toBe(false);
  });
});

describe("ERRORES_DE_ALTA", () => {
  it("son los cinco motivos que la pantalla sabe decir", () => {
    expect([...ERRORES_DE_ALTA]).toEqual(["datos", "cerrada", "intentos", "falla", "celular"]);
  });
});
