/**
 * De qué dirección dice venir un siniestro simulado.
 *
 * No es un detalle de formato: es lo que impide que un ensayo termine
 * mandándole un mail a una persona. `dispatch.ts` corta el envío mirando
 * `isReservedTestAddress(to)` —la dirección, no el canal— y ese `to` sale del
 * `from_addr` que guarda el simulador.
 *
 * Antes esto vivía adentro del route handler y no se podía probar sin fabricar
 * una petición HTTP. Peor: el caso interesante —un nombre con acentos o
 * apóstrofos— no se podía ejercitar desde ahí, porque en modo texto libre no
 * hay nombre. Un test a nivel ruta pasaba sin tocar la limpieza.
 */

import { describe, it, expect } from "vitest";

import { isReservedTestAddress } from "@/lib/email/reserved";
import { remitenteDeEnsayo } from "@/server/intake/remitente-de-ensayo";

describe("remitenteDeEnsayo", () => {
  it("sin nombre igual devuelve una dirección, no null", () => {
    // El caso que estaba roto: quedaba `null`, que termina como `to: ""`, e
    // `isReservedTestAddress("")` devuelve false. Lo frenaba que Gmail no puede
    // mandar a una dirección vacía, no la guarda.
    expect(remitenteDeEnsayo(null)).toBe("ensayo@example.com");
    expect(remitenteDeEnsayo(undefined)).toBe("ensayo@example.com");
    expect(remitenteDeEnsayo("")).toBe("ensayo@example.com");
  });

  it("con un nombre simple lo usa", () => {
    expect(remitenteDeEnsayo("Juan Pérez")).toBe("juan.perez@example.com");
  });

  it.each([
    ["acentos", "María José"],
    ["eñes", "Ñandú Ibáñez"],
    ["apóstrofos", "María José O'Higgins"],
    ["guiones", "Ana-Sofía Del Valle"],
    ["espacios de más", "  Ana   María  "],
    ["puros símbolos", "!!!"],
    ["puntos al borde", ".Pedro."],
  ])("con %s sale una dirección válida y reservada", (_c, nombre) => {
    const direccion = remitenteDeEnsayo(nombre);

    /*
     * Las dos mitades, y hacen falta las dos.
     *
     * `isReservedTestAddress` mira SÓLO el dominio —su expresión regular es
     * `@…example.(com|org|net)$`—, así que `o'higgins@example.com` le parece
     * perfecto. Con esa afirmación sola, sacar la limpieza del nombre no rompía
     * nada, y quedaba una dirección que ningún servidor de correo acepta.
     */
    expect(isReservedTestAddress(direccion)).toBe(true);
    expect(direccion).toMatch(/^[a-z0-9]+(?:\.[a-z0-9]+)*@example\.com$/);
  });

  it("no deja puntos al principio, al final ni repetidos", () => {
    // Un `from_addr` inválido vuelve al problema anterior: la guarda no lo
    // reconoce y lo que frena el envío es el error del proveedor.
    for (const nombre of ["  Ana   María  ", ".Pedro.", "O'Higgins  Ñandú"]) {
      const usuario = remitenteDeEnsayo(nombre).split("@")[0];
      expect(usuario).not.toMatch(/^\./);
      expect(usuario).not.toMatch(/\.$/);
      expect(usuario).not.toMatch(/\.\./);
      expect(usuario.length).toBeGreaterThan(0);
    }
  });

  it("siempre es example.com, que es el dominio que la guarda mira", () => {
    // Cambiarlo por algo como `claimmix.test` deja de estar reservado y el
    // ensayo pasa a mandar mensajes de verdad.
    expect(remitenteDeEnsayo("Quien Sea")).toMatch(/@example\.com$/);
  });
});
