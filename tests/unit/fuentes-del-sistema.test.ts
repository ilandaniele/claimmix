/**
 * Que `font-mono` sea monoespaciada de verdad, sin cargar fuentes web.
 *
 * `@theme` apuntaba `--font-sans` y `--font-mono` a `--font-geist-*`, variables
 * que nadie definía (no hay `next/font` ni `@font-face`): lo que usa `font-mono`
 * heredaba la pila del body y salía proporcional. Y el body pedía «Inter»
 * primero, que nunca se cargaba. La CSP es estricta y cada fuente suma peso, así
 * que el arreglo son pilas del sistema.
 *
 * Lee `globals.css` porque la pila sólo existe ahí.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

const CSS = readFileSync(path.resolve("src/app/globals.css"), "utf8");

/** El valor de una variable declarada dentro de un `@theme`. */
function valorEnTheme(variable: string): string {
  const re = new RegExp(`@theme\\s*\\{[^}]*?${variable}:\\s*([^;]+);`, "s");
  const m = re.exec(CSS);
  if (!m) throw new Error(`no encontré ${variable} en un @theme de globals.css`);
  return m[1].replace(/\s+/g, " ").trim();
}

describe("las fuentes de globals.css", () => {
  it("--font-mono es una pila monoespaciada del sistema que termina en monospace", () => {
    const pila = valorEnTheme("--font-mono");
    for (const f of ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", '"Liberation Mono"']) {
      expect(pila).toContain(f);
    }
    expect(pila.endsWith("monospace")).toBe(true);
  });

  it("--font-sans es una pila del sistema que termina en sans-serif", () => {
    const pila = valorEnTheme("--font-sans");
    expect(pila).toContain("system-ui");
    expect(pila.endsWith("sans-serif")).toBe(true);
  });

  it("no queda ninguna referencia a Geist ni a Inter, que nunca se cargan", () => {
    expect(CSS).not.toMatch(/--font-geist/);
    expect(CSS).not.toMatch(/\bInter\b/);
  });

  it("el body toma --font-sans en vez de repetir la pila", () => {
    const m = /(?<![.\w-])body\s*\{[^}]*?font-family:\s*([^;]+);/.exec(CSS);
    expect(m, "no encontré font-family en el body").not.toBeNull();
    expect(m![1].trim()).toBe("var(--font-sans)");
  });
});
