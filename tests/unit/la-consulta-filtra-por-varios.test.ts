/**
 * La bandeja ahora deja tildar varios chips a la vez —varios tipos, varios
 * estados— y el WHERE tiene que sumarlos con `in`, no reemplazar uno por otro.
 *
 * El riesgo puntual es `inArray(col, [])`: en Postgres eso no empareja NINGUNA
 * fila. Si `buildCaseFilters` recibiera una lista vacía y la pasara igual,
 * destildar el último chip de un filtro vaciaría la bandeja entera en vez de
 * mostrar todo — el mismo defecto que ya se documentó en el propio archivo.
 *
 * `QueryBuilder` arma la consulta sin conexión: no hay base de por medio.
 */

import { describe, it, expect } from "vitest";

import { QueryBuilder } from "drizzle-orm/pg-core";

import { cases } from "@/lib/db/schema";
import { buildCaseFilters } from "@/server/cases/list";

const sqlDe = (query: Parameters<typeof buildCaseFilters>[0]) => {
  const { sql: texto, params } = new QueryBuilder()
    .select()
    .from(cases)
    .where(buildCaseFilters(query))
    .toSQL();
  return { texto, params };
};

describe("el filtro de tipo acepta varios valores", () => {
  it("dos tipos arman un in con los dos parámetros", () => {
    const { texto, params } = sqlDe({ type: ["choque", "robo"] });

    expect(texto.toLowerCase()).toContain("in");
    expect(params).toEqual(["choque", "robo"]);
  });

  it("sin tipos no hay condición de tipo", () => {
    // `select()` sin columnas proyecta la tabla entera —"claim_type" sale
    // siempre ahí—, así que lo que hay que mirar es sólo el WHERE.
    const { texto } = sqlDe({ status: ["escalado"] });
    const where = texto.split(" where ")[1] ?? "";

    expect(where).not.toContain("claim_type");
  });

  it("buildCaseFilters({ type: [] }) no agrega condición, nunca in (null)", () => {
    // `.nonempty()` en el schema ya evita esto desde la URL — `as never` fuerza
    // el caso igual, porque `buildCaseFilters` también lo reciben tests y
    // `listCasesForExport` sin pasar por Zod. Si esto agregara
    // `inArray(cases.claim_type, [])`, destildar el último chip de tipo
    // dejaría la bandeja sin ninguna fila en vez de mostrarlas todas.
    expect(buildCaseFilters({ type: [] } as never)).toBeUndefined();
  });
});

describe("el filtro de estado consulta la unión de los grupos elegidos", () => {
  it("dos chips de estado consultan la unión de sus grupos, sin repetidos", () => {
    /*
     * `escalado` es el grupo {escalado, requiere_especialista} y `listo` es
     * {listo, listo_para_core, enviado_a_core} — los dos según
     * `ESTADOS_DE_LA_OPCION` en `filtro-de-estado.ts`, no un estado por chip.
     * La unión son los cinco, sin ninguno de más ni de menos.
     */
    const { params } = sqlDe({ status: ["escalado", "listo"] });

    expect(params).toEqual([
      "escalado",
      "requiere_especialista",
      "listo",
      "listo_para_core",
      "enviado_a_core",
    ]);
  });

  it("buildCaseFilters({ status: [] }) no agrega condición, nunca in (null)", () => {
    expect(buildCaseFilters({ status: [] } as never)).toBeUndefined();
  });
});
