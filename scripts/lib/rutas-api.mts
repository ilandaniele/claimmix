/**
 * Las rutas de la API, leídas del árbol de archivos y nunca escritas a mano.
 *
 * Una lista escrita a mano se desactualiza el primer día que alguien tiene
 * apuro, y falla de las dos maneras caras: la ruta nueva no la prueba nadie, y
 * la ruta renombrada se prueba como un 404 que parece una falla de otra cosa.
 *
 * Vivía adentro del pen test. La prueba de carga la necesita por el mismo
 * motivo —nombra rutas y tiene que poder afirmar que existen— así que vive acá
 * y no en uno de los dos.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Todos los `route.ts` bajo `dir`, como rutas relativas al repo. */
export function findRoutes(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findRoutes(full, acc);
    else if (entry.name === "route.ts") acc.push(path.relative(process.cwd(), full));
  }
  return acc;
}

/** `src/app/api/cases/[id]/route.ts` → `/api/cases/[id]`. */
export function routePattern(file: string): string {
  return (
    "/" + file.replace(/\\/g, "/").replace(/^src\/app\//, "").replace(/\/route\.ts$/, "")
  );
}

/** Lo mismo, pero pidible: los segmentos dinámicos toman un valor cualquiera. */
export function routeToUrl(file: string): string {
  return (
    "/" +
    file
      .replace(/\\/g, "/")
      .replace(/^src\/app\//, "")
      .replace(/\/route\.ts$/, "")
      .split("/")
      .map((seg) =>
        seg.startsWith("[...")
          ? "probe"
          : seg.startsWith("[")
            ? "00000000-0000-0000-0000-000000000001"
            : seg
      )
      .join("/")
  );
}
