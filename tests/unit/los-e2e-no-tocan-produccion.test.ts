/**
 * Los e2e escriben: crean casos, sesiones, filas del límite de tráfico. Que
 * `DATABASE_URL` o `DATABASE_URL_APP` apunten a producción por un descuido del
 * shell no puede pasar sin que algo lo frene antes de arrancar el servidor.
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { exigirQueNoSeaProduccion, hostDe, resumenDe, taparEnElLog } from "../e2e/base-de-ensayo";

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

  it("se planta con el esquema en mayúsculas o con producción en `?host=`", () => {
    expect(() =>
      exigirQueNoSeaProduccion({ DATABASE_URL: "POSTGRESQL://u:p@EP-PROUD-RESONANCE-acbz9jqu.us-east-2.aws.neon.tech/db" })
    ).toThrow(/PRODUCCIÓN/);
    expect(() =>
      exigirQueNoSeaProduccion({
        DATABASE_URL: "postgresql://u:p@ep-otra-rama.neon.tech/db?host=ep-proud-resonance-acbz9jqu.neon.tech",
      })
    ).toThrow(/PRODUCCIÓN/);
  });

  it("playwright.config.ts nunca reusa un servidor y llama a la guarda", () => {
    expect(CONFIG).toMatch(/reuseExistingServer:\s*false/);
    expect(CONFIG).not.toMatch(/reuseExistingServer:\s*!process\.env\.CI/);
    expect(CONFIG).toContain("exigirQueNoSeaProduccion()");
  });
});

describe("hostDe", () => {
  it("devuelve el host en minúsculas, con el de `?host=` detrás", () => {
    expect(hostDe("POSTGRES://u:p@EP-X.neon.tech/db")).toBe("ep-x.neon.tech");
    expect(hostDe("postgresql://u:p@ep-x.neon.tech/db?host=ep-y.neon.tech")).toBe("ep-x.neon.tech ep-y.neon.tech");
  });

  it("devuelve vacío si la cadena no se lee", () => {
    expect(hostDe(undefined)).toBe("");
    expect(hostDe("no-es-una-url")).toBe("");
  });
});

describe("resumenDe", () => {
  it("deja el código y la primera línea, sin URLs ni lo que sigue", () => {
    const e = Object.assign(new Error("falló postgresql://u:secreto@ep-x.neon.tech/db\nparams: dato"), {
      code: "28P01",
    });
    const r = resumenDe(e);
    expect(r).toBe("28P01: falló <url>");
    expect(r).not.toContain("secreto");
    expect(r).not.toContain("dato");
  });

  it("toma el código de `cause` si el error no trae uno propio", () => {
    expect(resumenDe(new Error("x", { cause: { code: "ECONNRESET" } }))).toBe("ECONNRESET: x");
  });

  it("con un evento sin mensaje (el ErrorEvent del WebSocket) deja la clase", () => {
    class ErrorEvent {
      message = "";
    }
    expect(resumenDe(new ErrorEvent())).toBe("error: ErrorEvent");
  });
});

describe("taparEnElLog", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fuera de GitHub Actions no imprime nada", () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    taparEnElLog(["Aseguradora"]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("en GitHub Actions escapa `%` y los saltos de línea", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    taparEnElLog(["100%0A", "a\nb", null, ""]);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["::add-mask::100%250A", "::add-mask::a%0Ab"]);
    log.mockRestore();
  });
});
