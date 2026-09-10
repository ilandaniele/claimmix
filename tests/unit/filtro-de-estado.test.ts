/**
 * Las cinco opciones de estado de la bandeja: cuántos casos dicen, y cuáles
 * devuelven al apretarlas.
 *
 * Antes esto eran dos controles que contaban lo mismo de dos formas: las
 * baldosas de arriba agrupaban los estados canónicos y las pestañas de abajo
 * contaban un estado suelto. Medido en producción el 10/09:
 *
 *     opción       pestaña   baldosa   casos de verdad
 *     Escalado           1        43   escalado 1 + requiere_especialista 42
 *     Listo              0        27   listo_para_core 27
 *     Esperando          0         6   info_faltante 6
 *
 * Tres de las cinco pestañas decían **0 sobre 483 casos**, porque el canal real
 * nunca escribe `listo`, `esperando` ni `escalado`.
 *
 * Lo que se prueba acá es la propiedad que hace que el arreglo sirva: **el
 * número del chip y lo que devuelve el filtro salen del mismo conjunto**. Un
 * chip que diga 43 y devuelva un caso es peor que uno que diga 1.
 */

import { describe, it, expect } from "vitest";

import {
  CLAVES_DE_ESTADO,
  ESTADOS_DE_LA_OPCION,
  contarPorOpcion,
  esClaveDeEstado,
  estadosAConsultar,
} from "@/core/case/filtro-de-estado";

/** Lo que había en producción el 10/09, tal cual salió del GROUP BY. */
const PRODUCCION = [
  { status: "no_relevante", count: 329 },
  { status: "cerrado", count: 76 },
  { status: "requiere_especialista", count: 42 },
  { status: "listo_para_core", count: 27 },
  { status: "info_faltante", count: 6 },
  { status: "confirmacion_pendiente", count: 2 },
  { status: "escalado", count: 1 },
];

describe("el contador de cada opción", () => {
  it("cuenta los dos vocabularios, que es lo que las pestañas no hacían", () => {
    const c = contarPorOpcion(PRODUCCION);

    // 42 del canal real + 1 del simulado. La pestaña decía 1.
    expect(c.escalado).toBe(43);
    // La pestaña decía 0 con 27 casos completados.
    expect(c.listo).toBe(27);
    expect(c.esperando).toBe(6);
    expect(c.confirmacion_pendiente).toBe(2);
    expect(c.cerrado).toBe(76);
  });

  it("un estado sin casos cuenta 0, no desaparece", () => {
    // No vuelve del GROUP BY, y su chip tiene que decir 0: un chip que se
    // esfuma cambia el ancho de la fila cada vez que entra un caso.
    expect(contarPorOpcion(PRODUCCION).procesando).toBe(0);
    expect(contarPorOpcion([]).escalado).toBe(0);
  });

  it("devuelve las cinco claves siempre", () => {
    const c = contarPorOpcion([]);
    for (const clave of CLAVES_DE_ESTADO) expect(c[clave]).toBe(0);
  });
});

describe("lo que el filtro consulta", () => {
  it("una clave de grupo pide todos sus estados", () => {
    expect(estadosAConsultar("escalado").sort()).toEqual(
      ["escalado", "requiere_especialista"].sort()
    );
    expect(estadosAConsultar("listo").sort()).toEqual(
      ["enviado_a_core", "listo", "listo_para_core"].sort()
    );
  });

  it("un estado suelto que no es clave de grupo pide ese solo", () => {
    // La URL la escribe cualquiera, y la API la usan el CSV y el sondeo en
    // vivo: `?status=requiere_especialista` tiene que seguir dando eso exacto.
    expect(estadosAConsultar("requiere_especialista")).toEqual([
      "requiere_especialista",
    ]);
    expect(estadosAConsultar("no_relevante")).toEqual(["no_relevante"]);
  });

  it("el contador y el filtro salen del MISMO conjunto", () => {
    /*
     * La propiedad que hace que esto sirva, y la que se rompe primero si
     * alguien toca uno de los dos lados: si el chip dice 43 y el filtro pide
     * otra cosa, la lista contradice al botón que se acaba de apretar.
     */
    const c = contarPorOpcion(PRODUCCION);
    const cuenta = new Map(PRODUCCION.map((r) => [r.status, r.count]));

    for (const clave of CLAVES_DE_ESTADO) {
      const sumaDeLoQueConsulta = estadosAConsultar(clave).reduce(
        (acc, s) => acc + (cuenta.get(s) ?? 0),
        0
      );
      expect(sumaDeLoQueConsulta).toBe(c[clave]);
    }
  });
});

describe("los cinco grupos no se pisan", () => {
  it("un caso cae en una sola opción", () => {
    /*
     * Es lo que un filtro necesita y lo que `ESTADOS_RESUELTOS` no da: incluye
     * `cerrado`, así que «Listo» y «Cerrado» compartirían 76 casos y los dos
     * números sumarían más que el total.
     */
    const vistos = new Map<string, string>();

    for (const clave of CLAVES_DE_ESTADO) {
      for (const estado of ESTADOS_DE_LA_OPCION[clave]) {
        const anterior = vistos.get(estado);
        expect(anterior, `${estado} está en ${anterior} y en ${clave}`).toBeUndefined();
        vistos.set(estado, clave);
      }
    }
  });

  it("y la suma de los cinco no pasa el total", () => {
    const c = contarPorOpcion(PRODUCCION);
    const total = PRODUCCION.reduce((a, r) => a + r.count, 0);
    const suma = CLAVES_DE_ESTADO.reduce((a, k) => a + c[k], 0);

    expect(suma).toBeLessThanOrEqual(total);
    // Lo que falta para el total son los 329 `no_relevante` y los `error_core`,
    // que no son estados de trabajo y por eso no tienen opción.
    expect(total - suma).toBe(329);
  });
});

describe("esClaveDeEstado", () => {
  it("reconoce las cinco y rechaza lo demás", () => {
    for (const clave of CLAVES_DE_ESTADO) expect(esClaveDeEstado(clave)).toBe(true);
    expect(esClaveDeEstado("requiere_especialista")).toBe(false);
    expect(esClaveDeEstado("meteorito")).toBe(false);
  });

  it("no confunde una propiedad heredada con una clave", () => {
    // `hasOwnProperty` y no `in`: con `in`, "toString" y "constructor" darían
    // true y terminarían en un `inArray` con un estado que no existe.
    expect(esClaveDeEstado("toString")).toBe(false);
    expect(esClaveDeEstado("constructor")).toBe(false);
  });
});
