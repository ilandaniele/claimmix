/**
 * Guarda: el puente de alcance de los tests vive en un solo lugar.
 *
 * El bloque viejo —la fábrica async de `@/data/scope` que importaba
 * `@/lib/db` y envolvía `armar(mod.db)` en Promise.resolve/Promise.all— estaba
 * copiado y pegado en más de medio centenar de archivos, más los `vi.doMock`
 * de `worker-harness.ts` y `dispatch-gmail.test.ts`. Si alguno vuelve a
 * copiarlo en vez de llamar a `tests/mocks/puente-de-alcance.ts`, esta guarda
 * lo agarra.
 */

import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const TESTS = join(ROOT, "tests");

const PERMITIDOS = new Set([
  "mocks/puente-de-alcance.ts",
  // Instrumentado: cuenta lotes e inyecta `loteFalla`, no es una copia del puente.
  "unit/server/worker/extract.lote-del-prompt.test.ts",
]);

const archivos = (readdirSync(TESTS, { recursive: true, encoding: "utf8" }) as string[])
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.split("\\").join("/"))
  .filter((f) => !PERMITIDOS.has(f));

// Sólo dentro de la fábrica vieja: buscar estas frases sueltas en todo el
// archivo marca comentarios que las mencionan (p. ej. data-scope-lote.test.ts)
// o mocks de `@/data/scope` que no tienen nada que ver con este bloque.
const PATRONES = ['Promise.resolve(armar(', 'Promise.all(armar(', 'await import("@/lib/db")'];
const FACTORY = /vi\.(mock|doMock)\("@\/data\/scope"/g;

function tieneBloqueViejo(txt: string): boolean {
  for (const m of txt.matchAll(FACTORY)) {
    const cuerpo = txt.slice(m.index, m.index + 400);
    if (PATRONES.some((p) => cuerpo.includes(p))) return true;
  }
  return false;
}

describe("un solo puente de alcance", () => {
  it("ningún test copia el bloque viejo en vez de llamar al puente", () => {
    const conBloqueViejo = archivos.filter((f) => tieneBloqueViejo(readFileSync(join(TESTS, f), "utf8")));

    expect(conBloqueViejo).toEqual([]);
  });

  it("el puente exporta las dos funciones que estos archivos llaman", () => {
    const txt = readFileSync(join(TESTS, "mocks/puente-de-alcance.ts"), "utf8");

    expect(txt).toContain("export function puenteDeAlcance");
    expect(txt).toContain("export async function puenteSobreLibDb");
  });
});
