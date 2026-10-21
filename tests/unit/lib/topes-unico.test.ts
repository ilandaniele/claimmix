/**
 * Guarda: todo tope se lee de `src/lib/topes.ts`.
 *
 * Un tope leído por fuera del registro vuelve a copiar su omisión y su rango
 * en otro lugar, y `/api/health` deja de mostrar el que rige. Esta guarda
 * recorre `src/` y falla con el archivo y la línea de cada lectura suelta.
 */

import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

import { describe, expect, it } from "vitest";

import { TOPES_DECIMALES, TOPES_ENTEROS } from "@/lib/topes";

const ROOT = resolve(__dirname, "../../..");
const REGISTRO = "src/lib/topes.ts";

const NOMBRES = [
  ...TOPES_ENTEROS.map((t) => t.nombre),
  ...TOPES_DECIMALES.map((t) => t.nombre),
  "AI_ANONIMO_DAILY_TOKEN_CAP",
];

/**
 * La función local `entero(valor)` de `src/core/retencion.ts` no cumple la
 * primera y queda afuera a propósito: no lee el entorno por nombre.
 */
const REGLAS: { motivo: string; patron: RegExp }[] = [
  { motivo: "entero() con nombre literal: usar topeEntero", patron: /\bentero\(\s*["'`]/g },
  { motivo: "readCap() sobre el entorno: usar topeDecimal", patron: /readCap\(\s*(process\.)?env\b/g },
  { motivo: "enteroDe() sobre el entorno: usar topeEntero", patron: /enteroDe\(\s*(process\.)?env\b/g },
  {
    motivo: "lectura directa de un tope: usar src/lib/topes.ts",
    patron: new RegExp(String.raw`\benv\??\.(?:${NOMBRES.join("|")})\b`, "g"),
  },
];

const ARCHIVOS = (
  readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" }) as string[]
)
  .map((f) => `src/${f.split("\\").join("/")}`)
  .filter((f) => /\.tsx?$/.test(f) && f !== REGISTRO);

function sueltas(texto: string): { linea: number; motivo: string }[] {
  const halladas: { linea: number; motivo: string }[] = [];
  for (const { motivo, patron } of REGLAS) {
    for (const m of texto.matchAll(patron)) {
      halladas.push({ linea: texto.slice(0, m.index).split("\n").length, motivo });
    }
  }
  return halladas;
}

describe("todos los topes salen de src/lib/topes.ts", () => {
  it("ningún archivo de src los lee por fuera del registro", () => {
    const fallas = ARCHIVOS.flatMap((archivo) =>
      sueltas(readFileSync(join(ROOT, archivo), "utf8")).map(
        ({ linea, motivo }) => `${archivo}:${linea} ${motivo}`
      )
    );

    expect(fallas).toEqual([]);
  });

  it("recorre el código y deja afuera sólo el registro", () => {
    expect(ARCHIVOS.length).toBeGreaterThan(100);
    expect(ARCHIVOS).toContain("src/lib/entero.ts");
    expect(ARCHIVOS).not.toContain(REGISTRO);
  });

  it("detecta cada forma de lectura suelta, con su línea", () => {
    const texto = [
      'const a = entero("ALTA_TOPE_BASES", 0, 0, 500);',
      "const b = readCap(process.env.X, 1);",
      "const c = enteroDe(env.X, 0, 1);",
      "const d = process.env.ALTA_TOPE_IP_DIA;",
      "const e = env.AI_ANONIMO_DAILY_TOKEN_CAP;",
      "const f = entero(valor);",
      "const g = process.env.OTRA_COSA;",
    ].join("\n");

    expect(sueltas(texto).map((s) => s.linea).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
