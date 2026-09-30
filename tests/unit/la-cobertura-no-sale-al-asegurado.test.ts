/**
 * Cobertura, monto estimado y lectura del presupuesto son del equipo (B6, B23,
 * B21), igual que la opinión de responsabilidad y la carta de un tercero (B18,
 * B24). Nada de lo que le escribe al asegurado —la respuesta del agente, su
 * prompt y sus herramientas, las plantillas— ni el aviso por mail al
 * especialista puede llegar a esos módulos ni nombrar esas columnas.
 *
 * Se recorre el grafo de imports a mano: un módulo nuevo que alguien importe
 * de rebote, tres archivos más abajo, también cuenta.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const SRC = join(RAIZ, "src");

const SALEN_AL_ASEGURADO = [
  "src/server/ai/compose-reply.ts",
  "src/server/ai/prompt.ts",
  "src/server/ai/claim-agent.ts",
  "src/server/ai/agent-tools.ts",
  "src/server/ai/deliberate.ts",
  "src/server/notify/specialist-alert.ts",
  "src/server/confirmations/messenger.ts",
  ...carpeta("src/server/email/templates"),
  ...carpeta("src/core/mensajes"),
];

const MODULOS_DEL_EQUIPO = [
  "src/core/case/cobertura.ts",
  "src/core/case/monto-estimado.ts",
  "src/core/case/presupuesto-taller.ts",
  "src/core/case/responsabilidad.ts",
  "src/core/case/reclamo-tercero.ts",
  "src/server/cases/lectura-reclamo.ts",
  "src/core/poliza/condiciones.ts",
  "src/server/ai/leer-documento.ts",
  "src/server/cases/detail-view.ts",
];

const COLUMNAS_DEL_EQUIPO = [
  "monto_estimado",
  "coberturas",
  "ambito_territorial",
  "condiciones_path",
  "condiciones_leidas_en",
  "rangos_de_monto",
  "lectura_presupuesto",
  // Con el punto: «responsabilidad civil» es un tipo de siniestro y lo nombra el prompt.
  ".responsabilidad",
  ".reclamo",
];

function carpeta(ruta: string): string[] {
  return readdirSync(join(RAIZ, ruta))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${ruta}/${f}`);
}

function resolver(desde: string, especificador: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = join(SRC, especificador.slice(2));
  else if (especificador.startsWith(".")) base = join(dirname(desde), especificador);
  else return null;
  for (const candidato of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(candidato) && existsSync(candidato)) return candidato;
  }
  return null;
}

/** Todo lo que `entrada` importa, directa o indirectamente, dentro de `src`. */
function alcanzables(entrada: string): Set<string> {
  const vistos = new Set<string>();
  const pendientes = [join(RAIZ, entrada)];
  while (pendientes.length) {
    const archivo = pendientes.pop()!;
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);
    const fuente = readFileSync(archivo, "utf8");
    // Un `import type` no lleva datos en tiempo de ejecución: el esquema de la
    // base importa los tipos nuevos y lo importa casi todo.
    for (const [, soloTipo, desde, suelto] of fuente.matchAll(
      /\b(?:import|export)\s+(type\s+)?[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g
    )) {
      if (soloTipo) continue;
      const destino = resolver(archivo, (desde ?? suelto)!);
      if (destino) pendientes.push(destino);
    }
  }
  return vistos;
}

const normal = (ruta: string) => relative(RAIZ, ruta).replaceAll("\\", "/");

describe("lo del equipo no sale al asegurado", () => {
  it("existen los archivos que se vigilan", () => {
    for (const ruta of [...SALEN_AL_ASEGURADO, ...MODULOS_DEL_EQUIPO]) {
      expect(existsSync(join(RAIZ, ruta)), ruta).toBe(true);
    }
    expect(SALEN_AL_ASEGURADO.some((r) => r.startsWith("src/server/email/templates/"))).toBe(true);
  });

  it("el recorrido ve un import de verdad, aunque venga de rebote", () => {
    const desdeLaFicha = [...alcanzables("src/app/(app)/casos/[id]/page.tsx")].map(normal);
    expect(desdeLaFicha).toContain("src/server/cases/detail-view.ts");
    expect(desdeLaFicha).toContain("src/core/case/cobertura.ts");
    expect(desdeLaFicha).toContain("src/core/case/responsabilidad.ts");
    expect(desdeLaFicha).toContain("src/core/case/reclamo-tercero.ts");
  });

  it.each(SALEN_AL_ASEGURADO)("%s no llega a la cobertura, el monto, el presupuesto, la responsabilidad ni la carta de un tercero", (entrada) => {
    const llega = [...alcanzables(entrada)].map(normal).filter((r) => MODULOS_DEL_EQUIPO.includes(r));
    expect(llega).toEqual([]);
  });

  it.each(SALEN_AL_ASEGURADO)("%s no nombra las columnas nuevas", (entrada) => {
    const fuente = readFileSync(join(RAIZ, entrada), "utf8");
    expect(COLUMNAS_DEL_EQUIPO.filter((c) => fuente.includes(c))).toEqual([]);
  });

  it.each(SALEN_AL_ASEGURADO)("%s no cita la ley de tránsito ni las reglas de responsabilidad", (entrada) => {
    const fuente = readFileSync(join(RAIZ, entrada), "utf8");
    expect(fuente).not.toMatch(/24\.?449|art48g|ley24449/i);
  });
});
