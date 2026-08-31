/**
 * Cómo escribe la gente los datos con los que la buscamos en el padrón.
 *
 * Un DNI se escribe `27.654.321`, `27654321` y `DNI 27 654 321`. Los buscadores
 * comparaban con igualdad exacta contra una columna que guarda los dígitos
 * pelados, así que una persona que lo escribía como lo escribe todo el mundo no
 * aparecía — y no fallaba nada: el caso quedaba sin cliente asociado y se le
 * volvían a pedir los datos que acababa de dar.
 */

import { describe, it, expect } from "vitest";

import {
  normalizarDni,
  normalizarEmail,
  normalizarNumeroPoliza,
  normalizarTelefono,
  sirveParaBuscar,
  MINIMO_DNI,
  MINIMO_TELEFONO,
} from "@/core/matching/normalizar";

describe("normalizarDni", () => {
  it("las tres formas de escribir el mismo documento dan lo mismo", () => {
    const esperado = "27654321";
    expect(normalizarDni("27.654.321")).toBe(esperado);
    expect(normalizarDni("27654321")).toBe(esperado);
    expect(normalizarDni("DNI 27 654 321")).toBe(esperado);
    expect(normalizarDni("  27.654.321  ")).toBe(esperado);
  });

  it("dos documentos distintos siguen siendo distintos", () => {
    // Sacar puntuación no puede juntar a dos personas.
    expect(normalizarDni("27.654.321")).not.toBe(normalizarDni("27.654.322"));
  });

  it("algo sin dígitos queda en la cadena vacía", () => {
    expect(normalizarDni("s/d")).toBe("");
    expect(normalizarDni("—")).toBe("");
  });
});

describe("normalizarNumeroPoliza", () => {
  it("mayúsculas y espacios no cambian el contrato", () => {
    expect(normalizarNumeroPoliza("pol 8812-r")).toBe("POL8812-R");
    expect(normalizarNumeroPoliza("POL8812-R")).toBe("POL8812-R");
    expect(normalizarNumeroPoliza(" POL 8812 - R ")).toBe("POL8812-R");
  });

  it("el guion sí importa: no es un separador que la gente invente", () => {
    // Se sacan espacios, no puntuación. `POL8812R` es otro número.
    expect(normalizarNumeroPoliza("POL8812R")).not.toBe(normalizarNumeroPoliza("POL-8812-R"));
  });
});

describe("normalizarTelefono", () => {
  it("prefijo, espacios, guiones y paréntesis no cambian el número", () => {
    const esperado = "5491100000000";
    expect(normalizarTelefono("+54 9 11 0000-0000")).toBe(esperado);
    expect(normalizarTelefono("+5491100000000")).toBe(esperado);
    expect(normalizarTelefono("(549) 11 0000 0000")).toBe(esperado);
  });

  it("un número sin código de país NO se hace igual a uno con código", () => {
    /*
     * A propósito. Adivinar el prefijo juntaría a dos personas distintas, y una
     * coincidencia por teléfono asocia el caso a un cliente. Se pierde una
     * coincidencia posible antes que ganar una equivocada.
     */
    expect(normalizarTelefono("1100000000")).not.toBe(normalizarTelefono("+5491100000000"));
  });
});

describe("normalizarEmail", () => {
  it("mayúsculas y espacios alrededor no cambian la dirección", () => {
    expect(normalizarEmail("  Cecilia@Example.COM ")).toBe("cecilia@example.com");
  });
});

describe("sirveParaBuscar", () => {
  it("la cadena vacía no sirve", () => {
    /*
     * La mitad peligrosa de normalizar. Buscar por vacío contra una columna
     * normalizada devuelve a TODA persona con el campo vacío, y con la
     * confianza alta de una coincidencia por documento. Encontrar a cualquiera
     * es peor que no encontrar a nadie.
     */
    expect(sirveParaBuscar("")).toBe(false);
  });

  it("un DNI necesita al menos seis dígitos", () => {
    expect(sirveParaBuscar(normalizarDni("s/d"), MINIMO_DNI)).toBe(false);
    expect(sirveParaBuscar(normalizarDni("123"), MINIMO_DNI)).toBe(false);
    expect(sirveParaBuscar(normalizarDni("27.654.321"), MINIMO_DNI)).toBe(true);
  });

  it("un teléfono necesita al menos siete", () => {
    expect(sirveParaBuscar(normalizarTelefono("123"), MINIMO_TELEFONO)).toBe(false);
    expect(sirveParaBuscar(normalizarTelefono("+54 9 11 0000-0000"), MINIMO_TELEFONO)).toBe(true);
  });
});
