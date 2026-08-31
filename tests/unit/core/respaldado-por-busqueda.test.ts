/**
 * Un valor escrito en la denuncia tiene que haber salido de una consulta.
 *
 * `plan.resolved` guarda el valor con confianza 0.95 —la más alta que maneja el
 * sistema— y CIERRA el pedido de ese campo, así que nunca se le vuelve a
 * preguntar a la persona. La única condición que le ponía `validate` era que el
 * plan hubiera llamado a alguna herramienta, no que el valor viniera de alguna.
 * Comprobado llamándola:
 *
 *   herramienta: polizas_por_dni → { encontradas: 0 }
 *   resolved:    policy_number = "POL-INVENTADA-9999"
 *   validate():  ACEPTADO
 *
 * El comentario del propio campo ya lo advertía: «un modelo que puede escribir
 * valores de memoria es un modelo que puede inventar un número de póliza».
 */

import { describe, it, expect } from "vitest";

import {
  estaRespaldado,
  separarPorRespaldo,
} from "@/core/case/respaldado-por-busqueda";

/** Lo que `think` guarda en el transcripto, tal cual. */
const ENCONTRO = [
  'polizas_por_dni({"dni":"27654321"}) → {"encontradas":1,"polizas":[{"numero":"POL-8812-R","tipo":"auto","vigente":true}]}',
];
const NO_ENCONTRO = [
  'polizas_por_dni({"dni":"25888101"}) → {"encontradas":0,"nota":"Ese DNI no figura como titular de ninguna póliza acá."}',
];

describe("estaRespaldado", () => {
  it("el número que devolvió la consulta, sí", () => {
    expect(estaRespaldado("POL-8812-R", ENCONTRO)).toBe(true);
  });

  it("uno inventado, no", () => {
    expect(estaRespaldado("POL-INVENTADA-9999", ENCONTRO)).toBe(false);
  });

  it("y con una consulta que no encontró nada, tampoco", () => {
    // El caso exacto que se midió: la herramienta contestó `encontradas: 0` y
    // el plan igual escribía un número.
    expect(estaRespaldado("POL-INVENTADA-9999", NO_ENCONTRO)).toBe(false);
  });

  it("sin ninguna consulta, nada está respaldado", () => {
    expect(estaRespaldado("POL-8812-R", [])).toBe(false);
  });

  it("acepta que el modelo reformatee", () => {
    /*
     * La consulta devuelve `POL-8812-R` y el plan puede escribir `pol 8812 r`.
     * Son el mismo dato: exigir el calco los separaría y descartaría un valor
     * bueno, que es el error caro de este arreglo.
     */
    expect(estaRespaldado("pol 8812 r", ENCONTRO)).toBe(true);
    expect(estaRespaldado("POL8812R", ENCONTRO)).toBe(true);
  });

  it("un valor sin letras ni números NO pasa", () => {
    /*
     * La guarda que hace que todo lo demás signifique algo. Al sacar la
     * puntuación, un `"—"` queda en la cadena vacía, y la cadena vacía está
     * contenida en CUALQUIER texto: sin este piso, todo lo que no tuviera
     * letras ni números se daría por respaldado siempre.
     */
    expect(estaRespaldado("—", ENCONTRO)).toBe(false);
    expect(estaRespaldado("", ENCONTRO)).toBe(false);
    expect(estaRespaldado("...", ENCONTRO)).toBe(false);
  });

  it("un valor de un solo carácter tampoco", () => {
    // Una sola letra aparece en cualquier resultado por casualidad.
    expect(estaRespaldado("a", ENCONTRO)).toBe(false);
  });

  it("mira TODAS las consultas, no sólo la última", () => {
    const varias = [
      'historial_del_caso({}) → {"campos":[]}',
      ...ENCONTRO,
      'verificar_poliza({"numero_poliza":"POL-0000"}) → {"existe":false}',
    ];
    expect(estaRespaldado("POL-8812-R", varias)).toBe(true);
  });
});

describe("separarPorRespaldo", () => {
  it("deja pasar lo respaldado y aparta lo demás", () => {
    const { respaldados, sinRespaldo } = separarPorRespaldo(
      [
        { field: "policy_number", value: "POL-8812-R" },
        { field: "dni", value: "99999999" },
      ],
      ENCONTRO
    );

    expect(respaldados.map((r) => r.field)).toEqual(["policy_number"]);
    expect(sinRespaldo.map((r) => r.field)).toEqual(["dni"]);
  });

  it("devuelve las dos listas: la descartada hace falta para poder decirlo", () => {
    // Un descarte silencioso deja el mismo agujero de antes — el campo sigue
    // faltando y nadie sabe que el agente creyó haberlo llenado.
    const { sinRespaldo } = separarPorRespaldo(
      [{ field: "policy_number", value: "POL-INVENTADA" }],
      NO_ENCONTRO
    );
    expect(sinRespaldo).toHaveLength(1);
  });

  it("sin nada que separar, dos listas vacías", () => {
    expect(separarPorRespaldo([], ENCONTRO)).toEqual({
      respaldados: [],
      sinRespaldo: [],
    });
  });
});
