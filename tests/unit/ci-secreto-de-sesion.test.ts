// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mismo criterio que `scripts/check-architecture.mjs`: sin comentarios, porque
// el workflow explica el defecto citando la expresión.
const sinComentarios = (nombre: string) =>
  readFileSync(resolve(process.cwd(), ".github/workflows", nombre), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

describe("el secreto de sesión de producción no llega a los jobs de PR", () => {
  it("ci.yml no lee secrets.BETTER_AUTH_SECRET", () => {
    expect(sinComentarios("ci.yml")).not.toMatch(/\$\{\{\s*secrets\.BETTER_AUTH_SECRET\b/);
  });

  it("cada job que firma sesiones genera su propio valor", () => {
    expect(sinComentarios("ci.yml").match(/openssl rand -hex 32/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("el ensayo de producción sigue usando el secreto de verdad", () => {
    expect(sinComentarios("deploy-checks.yml")).toMatch(/\$\{\{\s*secrets\.BETTER_AUTH_SECRET\b/);
  });
});
