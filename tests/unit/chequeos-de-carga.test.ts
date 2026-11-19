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
  entraPorTargetId,
  filasDe,
  filasDelPlan,
  lineasDelPlan,
  numeroDeLaPrimeraFila,
} from "../../scripts/lib/chequeos-de-carga.mjs";

// Los EXPLAIN reales de las consultas del tablero contra la base de DEV, como `claimmix_app`
// (RLS forzado): `viejo-*` antes de comparar contra `id_txt`, `nuevo-*` después.
const PLANES = join(process.cwd(), "tests/fixtures/planes-del-tablero");
const plan = (nombre: string): string[] => readFileSync(join(PLANES, `${nombre}.txt`), "utf8").trimEnd().split("\n");

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
    expect(filasDelPlan(null)).toEqual([]);
  });

  it("filasDelPlan deja una fila por línea del plan, venga el driver con un arreglo o con { rows }", () => {
    const filas = [{ "QUERY PLAN": "Index Scan" }, { "QUERY PLAN": "  Filter: (target_id = x)" }];
    expect(filasDelPlan(filas)).toEqual(["Index Scan", "  Filter: (target_id = x)"]);
    expect(filasDelPlan({ rows: filas })).toEqual(filasDelPlan(filas));
  });
});

describe("entraPorTargetId", () => {
  const bueno = [
    "Nested Loop  (cost=0.44..1648.05 rows=128 width=64)",
    "  ->  Seq Scan on cases  (cost=0.00..42.95 rows=128 width=64)",
    "        Filter: (is_claim IS TRUE)",
    "  ->  Result  (cost=0.44..12.53 rows=1 width=48)",
    "        One-Time Filter: ((NULLIF(current_setting('claimmix.tenant_id'::text, true), ''::text))::uuid = cases.tenant_id)",
    "        ->  Index Scan using idx_audit_log_trayecto on audit_log a  (cost=0.44..12.52 rows=1 width=175)",
    "              Index Cond: (target_id = ((cases.id)::text))",
    "              Filter: ((tenant_id = cases.tenant_id) AND (event_type = 'case.closed'::text))",
  ];

  // El plan de hoy, con la comparación contra `id_txt`: cada consulta entra a la auditoría con un
  // Index Cond sobre target_id y ninguna deja target_id de Filter.
  it.each(["contadores", "ciclo", "cuellos", "historial"])("el plan real de %s, ya arreglado, entra por target_id", (nombre) => {
    expect(entraPorTargetId(plan(`nuevo-${nombre}`))).toBeNull();
  });

  // El plan de antes: `target_id = cases.id::text` quedaba de Filter porque `uuid_out` no es
  // leakproof bajo RLS, y cada caso recorría el índice entero (1,1 a 20 millones de costo).
  it.each(["contadores", "ciclo", "cuellos"])("el plan real de %s, antes del arreglo, no pasa", (nombre) => {
    expect(entraPorTargetId(plan(`viejo-${nombre}`))).not.toBeNull();
  });

  it("dice qué falló: la auditoría recorrida entera, o target_id de Filter", () => {
    expect(entraPorTargetId(plan("viejo-contadores"))).toBe("recorre audit_log entera");
    expect(entraPorTargetId(plan("viejo-cuellos"))).toMatch(/fuera del índice/);
    expect(entraPorTargetId(plan("viejo-ciclo"))).toMatch(/fuera del índice/);
  });

  it("el plan sano de referencia pasa", () => {
    expect(entraPorTargetId(bueno)).toBeNull();
  });

  it("un Hash Join es la valla `offset 0` que falta", () => {
    const roto = [...bueno, "  ->  Hash Join  (cost=1.00..2.00 rows=1 width=1)"];
    expect(entraPorTargetId(roto)).toMatch(/Hash Join/);
  });

  it("target_id de Filter, o de Join Filter o de Hash Cond, no es entrar por índice", () => {
    for (const linea of [
      "        Filter: ((event_type = 'x'::text) AND (target_id = (cases.id)::text))",
      "        Join Filter: (a.target_id = (cases.id)::text)",
      "        Hash Cond: (a.target_id = (cases.id)::text)",
    ]) {
      expect(entraPorTargetId([...bueno, linea]), linea).toMatch(/fuera del índice/);
    }
  });

  it("un Seq Scan sobre audit_log, con o sin esquema, es recorrerla entera", () => {
    for (const nodo of ["audit_log", "public.audit_log"]) {
      expect(entraPorTargetId([...bueno, `  ->  Seq Scan on ${nodo}  (cost=0.00..9967.74 rows=730 width=37)`])).toBe(
        "recorre audit_log entera"
      );
    }
  });

  it("sin ningún Index Cond sobre target_id no entra por target_id", () => {
    expect(entraPorTargetId(["Seq Scan on cases  (cost=0.00..42.95 rows=128 width=64)"])).toMatch(/no entra/);
    expect(entraPorTargetId([])).toMatch(/no entra/);
  });

  it("no se confunde con lo que es de otra tabla: Seq Scan on cases, el alias cases_1 y el One-Time Filter", () => {
    const plano = [
      ...bueno,
      "  ->  Seq Scan on cases cases_1  (cost=0.00..42.96 rows=521 width=841)",
      "        One-Time Filter: ((NULLIF(current_setting('claimmix.tenant_id'::text, true), ''::text))::uuid = cases.tenant_id)",
    ];
    expect(entraPorTargetId(plano)).toBeNull();
  });

  it("un Recheck Cond sobre target_id re-chequea su propio Index Cond y no cuenta", () => {
    const bitmap = [
      "Bitmap Heap Scan on audit_log a  (cost=4.29..11.05 rows=1 width=8)",
      "  Recheck Cond: (target_id = ((cases.id)::text))",
      "  ->  Bitmap Index Scan on idx_audit_log_target  (cost=0.00..4.28 rows=2 width=0)",
      "        Index Cond: (target_id = ((cases.id)::text))",
    ];
    expect(entraPorTargetId(bitmap)).toBeNull();
  });

  it("acepta el Index Cond de los cuellos y el del índice de la auditoría con el tipo delante", () => {
    for (const linea of [
      "              Index Cond: (target_id = ((cases.id)::text))",
      "              Index Cond: ((target_type = 'case'::text) AND (target_id = ((cases.id)::text)))",
      "              Index Cond: (target_id = c.id_txt)",
    ]) {
      expect(entraPorTargetId([linea])).toBeNull();
    }
  });
});

describe("INDICES_DEL_TABLERO", () => {
  const dir = join(process.cwd(), "neon/migrations");

  it("vigila el índice de trayecto, el de los cuellos y el ciclo", () => {
    expect(INDICES_DEL_TABLERO.idx_audit_log_trayecto).toBe("0043");
  });

  it("vigila el índice por target_id, el de los contadores y el historial", () => {
    expect(INDICES_DEL_TABLERO.idx_audit_log_target).toBe("0001");
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
