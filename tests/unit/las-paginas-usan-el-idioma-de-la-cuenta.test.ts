/**
 * G32: las pantallas del shell (app)/ usan el idioma de la CUENTA
 * (`getAccountLocale`), no la cookie del dispositivo a secas — si no, una
 * cuenta en inglés ve el layout en un idioma y la página en otro.
 * `getServerLocale` queda sólo para pantallas sin sesión.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(__dirname, "../..");
const APP = join(ROOT, "src/app/(app)");

describe("las páginas del shell usan el idioma de la cuenta", () => {
  it("ningún archivo bajo src/app/(app) llama a getServerLocale(", () => {
    const archivos = (readdirSync(APP, { recursive: true, encoding: "utf8" }) as string[]).filter(
      (f) => f.endsWith(".ts") || f.endsWith(".tsx")
    );
    const conLlamada = archivos.filter((f) =>
      readFileSync(join(APP, f), "utf8").includes("getServerLocale(")
    );

    expect(conLlamada).toEqual([]);
  });
});
