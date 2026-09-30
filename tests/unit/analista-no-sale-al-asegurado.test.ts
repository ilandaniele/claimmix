/**
 * La asignación al analista, el puntaje de complejidad, los vencimientos y el
 * plan de trabajo son del equipo (B9, B10, B11, B13). Nada de lo que le escribe
 * al asegurado —la respuesta del agente, su prompt y sus herramientas, las
 * plantillas— ni el mensaje que arma el orquestador, ni lo que se exporta al
 * sistema del cliente, puede llegar a esos módulos ni nombrar esas columnas.
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

/** Lo que sale del sistema hacia afuera: no lleva nada del trabajo del equipo. */
const SALEN_AL_CLIENTE = [
  "src/server/core-sync/payload.ts",
  "src/server/core-sync/lectura.ts",
  "src/server/agents/export.ts",
];

const MODULOS_DEL_EQUIPO = [
  "src/core/case/plazos.ts",
  "src/core/case/puntaje-complejidad.ts",
  "src/core/case/asignacion.ts",
  "src/core/case/plan-de-trabajo.ts",
  "src/core/case/vencimiento-y-banda.ts",
  "src/server/cases/efectos-de-transicion.ts",
  "src/server/cases/guarda-de-asignacion.ts",
  "src/server/cases/plan-de-trabajo.ts",
  "src/server/cases/trabajo-del-equipo.ts",
  "src/server/cases/detail-view.ts",
];

/** Nombres exactos: «plazos» a secas es demasiado común para vigilarlo. */
const COLUMNAS_DEL_EQUIPO = [
  "puntaje_complejidad",
  "vence_en",
  "vence_plazo",
  "reglas_asignacion",
  "pesos_puntaje",
  "plan_por_tipo",
  "case_plan_pasos",
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

const leer = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8");

const nombrados = (fuente: string) => COLUMNAS_DEL_EQUIPO.filter((c) => fuente.includes(c));

/** Desde `inicio` hasta la llave que lo cierra, contando llaves. */
function bloque(fuente: string, inicio: string, desde = 0): string {
  const i = fuente.indexOf(inicio, desde);
  expect(i, `no está «${inicio}»`).toBeGreaterThanOrEqual(0);
  const abre = fuente.indexOf("{", i);
  let nivel = 0;
  for (let j = abre; j < fuente.length; j++) {
    if (fuente[j] === "{") nivel++;
    else if (fuente[j] === "}" && --nivel === 0) return fuente.slice(i, j + 1);
  }
  throw new Error(`«${inicio}» no cierra`);
}

describe("lo del analista no sale al asegurado", () => {
  it("existen los archivos que se vigilan", () => {
    for (const ruta of [...SALEN_AL_ASEGURADO, ...SALEN_AL_CLIENTE, ...MODULOS_DEL_EQUIPO]) {
      expect(existsSync(join(RAIZ, ruta)), ruta).toBe(true);
    }
    expect(SALEN_AL_ASEGURADO.some((r) => r.startsWith("src/server/email/templates/"))).toBe(true);
  });

  it("el recorrido ve un import de verdad, aunque venga de rebote", () => {
    const desdeLaFicha = [...alcanzables("src/app/(app)/casos/[id]/page.tsx")].map(normal);
    expect(desdeLaFicha).toContain("src/server/cases/detail-view.ts");
    expect(desdeLaFicha).toContain("src/core/case/plazos.ts");
    expect(desdeLaFicha).toContain("src/core/case/plan-de-trabajo.ts");

    const desdeElOrquestador = [...alcanzables("src/server/confirmations/orchestrate.ts")].map(normal);
    expect(desdeElOrquestador).toContain("src/server/cases/efectos-de-transicion.ts");
  });

  it.each(SALEN_AL_ASEGURADO)("%s no llega a la asignación, el puntaje, los plazos ni el plan", (entrada) => {
    const llega = [...alcanzables(entrada)].map(normal).filter((r) => MODULOS_DEL_EQUIPO.includes(r));
    expect(llega).toEqual([]);
  });

  it.each([...SALEN_AL_ASEGURADO, ...SALEN_AL_CLIENTE])("%s no nombra las columnas del trabajo del equipo", (entrada) => {
    expect(nombrados(leer(entrada))).toEqual([]);
  });

  it.each(["src/server/core-sync/payload.ts", "src/server/agents/export.ts"])(
    "%s no llega a la asignación, el puntaje, los plazos ni el plan",
    (entrada) => {
      const llega = [...alcanzables(entrada)].map(normal).filter((r) => MODULOS_DEL_EQUIPO.includes(r));
      expect(llega).toEqual([]);
    }
  );
});

describe("lo del analista no viaja en lo que se le manda al asegurado", () => {
  const orquestador = leer("src/server/confirmations/orchestrate.ts");

  it("ningún `messenger.send` del orquestador lleva el criterio de trabajo del equipo", () => {
    const envios: string[] = [];
    for (let i = orquestador.indexOf("messenger.send({"); i >= 0; i = orquestador.indexOf("messenger.send({", i + 1)) {
      envios.push(bloque(orquestador, "messenger.send({", i));
    }
    expect(envios.length).toBeGreaterThan(0);
    for (const envio of envios) {
      expect(envio).not.toMatch(/\btrabajo\b|criterios|asign|puntaje|vence/i);
    }
  });

  it("`AgentMessage` no tiene dónde llevar el trabajo del equipo", () => {
    const mensaje = bloque(leer("src/server/confirmations/messenger.ts"), "export interface AgentMessage");
    expect(nombrados(mensaje)).toEqual([]);
    expect(mensaje).not.toMatch(/trabajo|asign|puntaje|vence/i);
  });

  it("las columnas que se sincronizan al sistema del cliente no incluyen las del equipo", () => {
    const columnas = bloque(leer("src/server/core-sync/lectura.ts"), "export const columnasDelCaso");
    expect(nombrados(columnas)).toEqual([]);
    expect(columnas).not.toMatch(/asignado|assigned/i);
  });
});

describe("lo del analista no entra al prompt de extracción", () => {
  const extract = leer("src/server/worker/extract.ts");

  it("`LoDelPrompt` no tiene un campo del trabajo del equipo", () => {
    const interfaz = bloque(extract, "interface LoDelPrompt");
    expect(nombrados(interfaz)).toEqual([]);
    expect(interfaz).not.toMatch(/trabajo|asign|puntaje|vence/i);
  });

  it("lo que arma el prompt y la llamada al extractor no nombran esas columnas", () => {
    const desde = extract.indexOf("// ── c) Todo lo que arma el prompt");
    const hasta = extract.indexOf("// ── e2) Defensive hydration");
    expect(desde).toBeGreaterThan(0);
    expect(hasta).toBeGreaterThan(desde);
    const tramo = extract.slice(desde, hasta);
    expect(nombrados(tramo)).toEqual([]);
    expect(tramo).not.toMatch(/reglas_asignacion|pesos_puntaje|plan_por_tipo/);
  });
});
