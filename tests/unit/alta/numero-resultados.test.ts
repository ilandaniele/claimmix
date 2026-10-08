/**
 * La lista cerrada de lo que /configuracion le cuenta al admin sobre su número,
 * y la bandera que prende todo el flujo.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { esExitoDelNumero, esResultadoDelNumero, RESULTADOS_DEL_NUMERO } from "@/server/alta/numero-resultados";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("esResultadoDelNumero", () => {
  it.each(RESULTADOS_DEL_NUMERO)("%s es un resultado", (resultado) => {
    expect(esResultadoDelNumero(resultado)).toBe(true);
  });

  it.each([undefined, null, "", "raro", "CONECTADO", 1, ["conectado"], { conectado: true }])("%j no lo es", (valor) => {
    expect(esResultadoDelNumero(valor)).toBe(false);
  });
});

describe("esExitoDelNumero", () => {
  it("sólo el código enviado y el número conectado salieron bien", () => {
    expect(RESULTADOS_DEL_NUMERO.filter(esExitoDelNumero)).toEqual(["codigo_enviado", "conectado"]);
  });
});

describe("numeroAutomatico", () => {
  it("está apagado sin la variable", () => {
    vi.stubEnv("ALTA_NUMERO_AUTOMATICO", undefined);
    expect(numeroAutomatico()).toBe(false);
  });

  it("sólo el 1 lo prende", () => {
    vi.stubEnv("ALTA_NUMERO_AUTOMATICO", "1");
    expect(numeroAutomatico()).toBe(true);
    for (const valor of ["0", "true", "si", " 1", "on"]) {
      vi.stubEnv("ALTA_NUMERO_AUTOMATICO", valor);
      expect(numeroAutomatico(), valor).toBe(false);
    }
  });
});
