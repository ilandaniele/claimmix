/**
 * La lista cerrada de lo que /configuracion y /preparando le cuentan al admin
 * sobre su número, qué panel pintan cada una, y la bandera que prende todo el flujo.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import {
  esExitoDelNumero,
  esResultadoDelNumero,
  panelDelNumero,
  RESULTADOS_DEL_NUMERO,
} from "@/server/alta/numero-resultados";

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

describe("panelDelNumero", () => {
  it("con la bandera o la prueba sin vigencia (automatico false) no pinta nada, ni con resultado ni con formularios", () => {
    expect(panelDelNumero(false, true, "conectado")).toBeNull();
    expect(panelDelNumero(false, false, "conectado")).toBeNull();
    expect(panelDelNumero(false, true, undefined)).toBeNull();
  });

  it("automatico, con el número por conectar y sin resultado: los formularios solos", () => {
    expect(panelDelNumero(true, true, undefined)).toEqual({ resultado: null, formularios: true });
  });

  it("automatico, con el número por conectar y un resultado: las dos cosas", () => {
    expect(panelDelNumero(true, true, "revision")).toEqual({ resultado: "revision", formularios: true });
  });

  it("automatico, ya sin número por conectar: sólo el resultado", () => {
    expect(panelDelNumero(true, false, "conectado")).toEqual({ resultado: "conectado", formularios: false });
  });

  it("automatico, sin nada que decir ni que pedir: nada", () => {
    expect(panelDelNumero(true, false, undefined)).toBeNull();
  });

  it.each(["raro", "CONECTADO", "<script>", "", ["conectado"], { conectado: true }, 7, null])(
    "un ?wa= que no está en la lista (%j) no pinta aviso",
    (wa) => {
      expect(panelDelNumero(true, false, wa)).toBeNull();
      expect(panelDelNumero(true, true, wa)).toEqual({ resultado: null, formularios: true });
    }
  );

  it.each(RESULTADOS_DEL_NUMERO)("%s se pinta, con o sin formularios", (resultado) => {
    expect(panelDelNumero(true, false, resultado)).toEqual({ resultado, formularios: false });
    expect(panelDelNumero(true, true, resultado)).toEqual({ resultado, formularios: true });
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
