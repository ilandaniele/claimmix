/**
 * Lo que la página pública pone en `pattern` (B17): las mismas expresiones que
 * valida la ruta, y compilables por el navegador. Si un `pattern` no compila
 * con la bandera `v`, el navegador lo ignora en silencio y quien denuncia
 * pierde su relato cuando el servidor rechaza lo que la página dejó pasar.
 */

import { describe, expect, it } from "vitest";

import { patronHtml } from "@/components/patron-html";
import { FORMATO_DE_CLAVE_DE_RAMO } from "@/core/case/ramos";
import { sinControlNiAngulares } from "@/core/text/sin-control";
import {
  PATRON_DE_CORREO,
  PATRON_DE_NOMBRE,
  PATRON_DE_SLUG,
  PATRON_DE_TELEFONO,
  slugAlAzar,
  slugValido,
} from "@/core/web/formulario";

/** Lo que hace el navegador con `pattern="…"`: `^(?:…)$` con la bandera `v`. */
const comoElNavegador = (patron: RegExp) => new RegExp(`^(?:${patronHtml(patron)})$`, "v");

describe("patronHtml", () => {
  it("quita las anclas y deja el resto igual", () => {
    expect(patronHtml(/^[a-z][a-z0-9_]{1,39}$/)).toBe("[a-z][a-z0-9_]{1,39}");
    expect(patronHtml(/^(?!\.)abc$/u)).toBe(String.raw`(?!\.)abc`);
  });
});

describe.each([
  ["PATRON_DE_CORREO", PATRON_DE_CORREO],
  ["PATRON_DE_TELEFONO", PATRON_DE_TELEFONO],
  ["PATRON_DE_NOMBRE", PATRON_DE_NOMBRE],
  ["PATRON_DE_SLUG", PATRON_DE_SLUG],
  ["FORMATO_DE_CLAVE_DE_RAMO", FORMATO_DE_CLAVE_DE_RAMO],
])("%s como pattern de HTML", (_nombre, patron) => {
  it("compila con la bandera v del navegador", () => {
    expect(() => comoElNavegador(patron)).not.toThrow();
  });
});

describe("PATRON_DE_CORREO", () => {
  it.each(["ana@ejemplo.com", "ana.perez+seguro@mail.ejemplo.com.ar", "a_b-c@x-y.io", "O'Brien@ejemplo.com"])(
    "%s sirve, para la ruta y para el navegador",
    (correo) => {
      expect(PATRON_DE_CORREO.test(correo)).toBe(true);
      expect(comoElNavegador(PATRON_DE_CORREO).test(correo)).toBe(true);
    }
  );

  it.each(["ana@empresa", "ana@", "@ejemplo.com", "a@b.com, c@d.com", "ana perez@ejemplo.com", ".ana@ejemplo.com", "a..b@ejemplo.com", "ana@ejemplo.c"])(
    "%s no sirve, para la ruta ni para el navegador",
    (correo) => {
      expect(PATRON_DE_CORREO.test(correo)).toBe(false);
      expect(comoElNavegador(PATRON_DE_CORREO).test(correo)).toBe(false);
    }
  );
});

describe("PATRON_DE_TELEFONO", () => {
  it.each(["+54 291 555-1234", "(0291) 555.1234", "291555123"])("%s sirve", (telefono) => {
    expect(PATRON_DE_TELEFONO.test(telefono)).toBe(true);
    expect(comoElNavegador(PATRON_DE_TELEFONO).test(telefono)).toBe(true);
  });

  it.each(["llamame", "12345", "1".repeat(41), "291 555 1234 int 2", "291/555"])("%s no sirve", (telefono) => {
    expect(PATRON_DE_TELEFONO.test(telefono)).toBe(false);
    expect(comoElNavegador(PATRON_DE_TELEFONO).test(telefono)).toBe(false);
  });
});

describe("PATRON_DE_NOMBRE", () => {
  /** Lo que la ruta acepta del nombre: recortado, de 2 a 80 caracteres, sin controles ni ángulos. */
  const laRutaLoAcepta = (s: string) => {
    const nombre = s.trim();
    return nombre.length >= 2 && nombre.length <= 80 && sinControlNiAngulares(nombre);
  };

  it.each([
    "Ana Pérez",
    "Li",
    "  Ana  ",
    "José María de la Cruz",
    "Ana Pérez",
    "A",
    "  A  ",
    "   ",
    "Ana <b>",
    "Ana>",
    "Ana​Pérez",
    "​Ana",
    "Ana\tPérez",
    "x".repeat(80),
  ])("%j: el patrón coincide con lo que acepta la ruta", (nombre) => {
    expect(PATRON_DE_NOMBRE.test(nombre)).toBe(laRutaLoAcepta(nombre));
    expect(comoElNavegador(PATRON_DE_NOMBRE).test(nombre)).toBe(laRutaLoAcepta(nombre));
  });
});

describe("slugValido y slugAlAzar", () => {
  it("el enlace al azar tiene el formato y no parece un uuid", () => {
    for (let i = 0; i < 50; i++) {
      const slug = slugAlAzar();
      expect(slug).toMatch(/^denuncia-[0-9a-f]{8}$/);
      expect(slugValido(slug)).toBe(true);
    }
  });

  it("dos enlaces al azar no coinciden", () => {
    expect(new Set(Array.from({ length: 20 }, slugAlAzar)).size).toBe(20);
  });

  it.each(["mi-aseguradora", "abc1", "a".repeat(40)])("%s es un enlace válido", (slug) => {
    expect(slugValido(slug)).toBe(true);
    expect(comoElNavegador(PATRON_DE_SLUG).test(slug)).toBe(true);
  });

  it.each(["abc", "a".repeat(41), "-empieza", "termina-", "Mayuscula", "con espacios", "12345678-1234-1234-1234-123456789012"])(
    "%s no lo es",
    (slug) => {
      expect(slugValido(slug)).toBe(false);
    }
  );
});
