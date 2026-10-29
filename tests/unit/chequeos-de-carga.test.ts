/**
 * Lo que `pnpm load` lee de la base antes de dar un veredicto.
 *
 * El chequeo del acumulador de IA contaba con `Number(lineasDelPlan(...))`, y
 * `Number("")` vale 0: un resultado vacío o de otra forma (otro driver, otra
 * forma de `enTenantVarias`) daba «cero diferencias» y apagaba, sin avisar, el
 * único guardián que mira si el trigger de la 0046 sigue manteniendo el tablero.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INDICES_DEL_TABLERO,
  filasDe,
  lineasDelPlan,
  numeroDeLaPrimeraFila,
} from "../../scripts/lib/chequeos-de-carga.mjs";

describe("numeroDeLaPrimeraFila", () => {
  it("lee el número venga el driver con un arreglo o con { rows }", () => {
    expect(numeroDeLaPrimeraFila([{ n: 0 }])).toBe(0);
    expect(numeroDeLaPrimeraFila({ rows: [{ n: 3 }] })).toBe(3);
  });

  it("acepta un número que llega como texto", () => {
    expect(numeroDeLaPrimeraFila([{ n: "5" }])).toBe(5);
  });

  it.each([
    ["un arreglo vacío", []],
    ["{ rows } vacío", { rows: [] }],
    ["un objeto sin rows", {}],
    ["null", null],
    ["undefined", undefined],
    ["una fila sin columnas", [{}]],
    ["una fila que no es un objeto", [7]],
    ["un valor nulo", [{ n: null }]],
    ["un texto vacío, que Number() convertiría en 0", [{ n: "" }]],
    ["un texto que no es un número", [{ n: "abc" }]],
    ["NaN", [{ n: Number.NaN }]],
    ["infinito", [{ n: Number.POSITIVE_INFINITY }]],
  ])("no da un número si el resultado es %s", (_nombre, resultado) => {
    expect(numeroDeLaPrimeraFila(resultado)).toBeNull();
  });
});

describe("lineasDelPlan y filasDe", () => {
  it("juntan la primera columna de cada fila del EXPLAIN", () => {
    const filas = [{ "QUERY PLAN": "Index Scan" }, { "QUERY PLAN": "Index Cond: (target_id = x)" }];
    expect(lineasDelPlan(filas)).toBe("Index Scan Index Cond: (target_id = x)");
    expect(lineasDelPlan({ rows: filas })).toBe(lineasDelPlan(filas));
  });

  it("un resultado vacío o de otra forma no tiene filas", () => {
    expect(filasDe(null)).toEqual([]);
    expect(filasDe({})).toEqual([]);
    expect(lineasDelPlan([])).toBe("");
  });
});

describe("INDICES_DEL_TABLERO", () => {
  const dir = join(process.cwd(), "neon/migrations");

  it("vigila el índice de trayecto, el de los cuellos y el ciclo", () => {
    expect(INDICES_DEL_TABLERO.idx_audit_log_trayecto).toBe("0043");
  });

  it.each(Object.entries(INDICES_DEL_TABLERO))(
    "%s lo crea la migración %s, la que el rojo manda a aplicar",
    (indice, version) => {
      const archivos = readdirSync(dir).filter((f) => f.startsWith(`${version}_`));
      expect(archivos).toHaveLength(1);
      const sql = readFileSync(join(dir, archivos[0]!), "utf8");
      expect(sql).toMatch(
        new RegExp(`CREATE\\s+INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(public\\.)?${indice}\\b|CONSTRAINT\\s+${indice}\\s+UNIQUE\\b`, "i")
      );
    }
  );
});
