/**
 * A un asegurado inventado no se le entrega nada.
 *
 * Los dominios `example.*` y el bloque telefónico `5490000…` existen para poder
 * ejercitar el flujo entero sin escribirle a una persona. El freno estaba
 * escrito dos veces, cada una con su agujero:
 *
 *   · El del mail comparaba el encabezado crudo contra `/@example\.(com)$/`.
 *     Funciona con la dirección pelada —como la manda el ensayo— y falla con
 *     `Nombre <a@example.com>`, que es como la manda cualquier cliente de
 *     correo: la cadena termina en `>`. `pnpm knock` depositó en la casilla un
 *     mensaje con forma de mail real y la respuesta salió de verdad.
 *
 *   · El del teléfono vivía sólo en el mensajero simulado, así que un mensaje
 *     que entrara por el webhook firmado usaba el mensajero real y el intento
 *     salía hacia Meta — que es de las cosas por las que restringen una cuenta
 *     de WhatsApp Business.
 *
 * Los dos frenos ahora están en el destinatario, que es donde vale para todos
 * los caminos.
 */

import { describe, it, expect } from "vitest";
import { bareAddress, isReservedTestAddress } from "@/lib/email/reserved";
import { isReservedTestNumber } from "@/core/phone/reserved";

describe("bareAddress", () => {
  it("saca la dirección de adentro de los ángulos", () => {
    expect(bareAddress("Asegurado de prueba <timbre.123@example.com>")).toBe(
      "timbre.123@example.com"
    );
  });

  it("deja pasar una dirección pelada", () => {
    expect(bareAddress("ensayo@example.com")).toBe("ensayo@example.com");
  });

  it("no se marea con espacios ni mayúsculas", () => {
    expect(bareAddress("  Ana <Ana@Example.COM>  ")).toBe("ana@example.com");
  });

  it("sin nada, nada", () => {
    expect(bareAddress(null)).toBe("");
    expect(bareAddress("")).toBe("");
  });
});

describe("isReservedTestAddress", () => {
  it("reconoce la dirección con nombre visible — el caso que fallaba", () => {
    expect(isReservedTestAddress("Asegurado de prueba <timbre.123@example.com>")).toBe(true);
  });

  it("reconoce las tres reservadas y sus subdominios", () => {
    expect(isReservedTestAddress("a@example.com")).toBe(true);
    expect(isReservedTestAddress("a@example.org")).toBe(true);
    expect(isReservedTestAddress("a@example.net")).toBe(true);
    expect(isReservedTestAddress("a@mail.example.com")).toBe(true);
  });

  it("no confunde un dominio que sólo se le parece", () => {
    // La dirección de una persona no puede terminar bloqueada por parecerse a
    // una reservada: sería un asegurado esperando una respuesta que nunca sale.
    expect(isReservedTestAddress("a@example.com.ar")).toBe(false);
    expect(isReservedTestAddress("a@notexample.com")).toBe(false);
    expect(isReservedTestAddress("a@exampleshop.com")).toBe(false);
    expect(isReservedTestAddress("ana@aseguradora.com.ar")).toBe(false);
  });
});

describe("isReservedTestNumber", () => {
  it("reconoce el bloque que inventa este sistema", () => {
    expect(isReservedTestNumber("5490000123456")).toBe(true);
  });

  it("no le importa el formato: es el mismo destinatario", () => {
    expect(isReservedTestNumber("+54 9 0000 12-3456")).toBe(true);
  });

  it("un número de verdad no es del bloque", () => {
    expect(isReservedTestNumber("5492916426930")).toBe(false);
    expect(isReservedTestNumber("5491100000000")).toBe(false);
  });

  it("sin número, no", () => {
    expect(isReservedTestNumber(null)).toBe(false);
    expect(isReservedTestNumber("")).toBe(false);
    expect(isReservedTestNumber("sin dígitos")).toBe(false);
  });
});
