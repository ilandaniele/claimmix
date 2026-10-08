// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// El compilado de Next no trae tipos; es el mismo matcher que usa para `source`.
const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as {
  pathToRegexp: (ruta: string) => RegExp;
};

// Next no pisa una cabecera que la config ya fijó: si `next.config.ts` le pone
// su CSP al adjunto servido, la del handler (con `sandbox`) no llega al
// navegador. `tests/e2e/adjunto-svg.spec.ts` lo comprueba por el cable; esto
// comprueba que el patrón deje afuera ESA ruta y ninguna otra.
describe("la CSP que next.config.ts le pone a /api", () => {
  const fuente = readFileSync(resolve(process.cwd(), "next.config.ts"), "utf8");
  const origen = [...fuente.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]).find((s) => s.startsWith("/api/"));

  const ID = "a1b2c3d4-0000-4000-8000-000000000001";

  it("hay un patrón para /api", () => {
    expect(origen).toBeTruthy();
  });

  it("no alcanza al adjunto servido, que fija la suya", () => {
    expect(pathToRegexp(origen!).test(`/api/cases/${ID}/attachments/${ID}`)).toBe(false);
  });

  it.each([
    `/api/cases/${ID}/attachments/${ID}/presupuesto`,
    `/api/cases/${ID}/attachments`,
    `/api/cases/${ID}`,
    "/api/cases/export.csv",
    "/api/health",
  ])("sí alcanza a %s", (ruta) => {
    expect(pathToRegexp(origen!).test(ruta)).toBe(true);
  });
});
