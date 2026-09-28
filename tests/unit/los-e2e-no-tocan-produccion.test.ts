/**
 * Los e2e escriben: crean casos, sesiones, filas del límite de tráfico. Que
 * `DATABASE_URL` o `DATABASE_URL_APP` apunten a producción por un descuido del
 * shell no puede pasar sin que algo lo frene antes de arrancar el servidor.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { exigirQueNoSeaProduccion } from "../e2e/base-de-ensayo";

const CONFIG = readFileSync("playwright.config.ts", "utf8");

describe("exigirQueNoSeaProduccion", () => {
  it("se planta si DATABASE_URL apunta a producción, sin la contraseña en el mensaje", () => {
    expect(() =>
      exigirQueNoSeaProduccion({
        DATABASE_URL:
          "postgresql://u:secreto@ep-proud-resonance-acbz9jqu.us-east-2.aws.neon.tech/neondb?sslmode=require",
      })
    ).toThrow(/PRODUCCIÓN/);
    try {
      exigirQueNoSeaProduccion({
        DATABASE_URL:
          "postgresql://u:secreto@ep-proud-resonance-acbz9jqu.us-east-2.aws.neon.tech/neondb?sslmode=require",
      });
    } catch (err) {
      expect(String(err)).toContain("ep-proud-resonance-acbz9jqu.us-east-2.aws.neon.tech");
      expect(String(err)).not.toContain("secreto");
    }
  });

  it("se planta igual si es DATABASE_URL_APP la que apunta a producción", () => {
    expect(() =>
      exigirQueNoSeaProduccion({
        DATABASE_URL_APP: "postgresql://u:p@ep-proud-resonance-acbz9jqu.us-east-2.aws.neon.tech/neondb",
      })
    ).toThrow(/PRODUCCIÓN/);
  });

  it("no se planta con otra rama, sin nada seteado, o con la cadena vacía", () => {
    expect(() =>
      exigirQueNoSeaProduccion({ DATABASE_URL: "postgresql://u:p@ep-otra-rama.us-east-2.aws.neon.tech/db" })
    ).not.toThrow();
    expect(() => exigirQueNoSeaProduccion({})).not.toThrow();
    expect(() => exigirQueNoSeaProduccion({ DATABASE_URL: "" })).not.toThrow();
  });

  it("no se planta si la cadena no se puede leer como URL", () => {
    expect(() => exigirQueNoSeaProduccion({ DATABASE_URL: "no-es-una-url" })).not.toThrow();
  });

  it("playwright.config.ts nunca reusa un servidor y llama a la guarda", () => {
    expect(CONFIG).toMatch(/reuseExistingServer:\s*false/);
    expect(CONFIG).not.toMatch(/reuseExistingServer:\s*!process\.env\.CI/);
    expect(CONFIG).toContain("exigirQueNoSeaProduccion()");
  });
});
