/**
 * `errorCode` reemplaza unas veinte copias de la misma extracción de código de
 * error (`gap-analyzer.ts:379` entre ellas). El contrato: código nativo primero,
 * si no hay, el nombre de la clase de `Error`, y si tampoco, `"UnknownError"`.
 */

import { describe, it, expect } from "vitest";
import { errorCode } from "@/lib/observability/error-code";

describe("errorCode", () => {
  it("usa el código nativo cuando está", () => {
    expect(errorCode({ code: "23505" })).toBe("23505");
  });

  it("cae al nombre de la clase de Error sin código", () => {
    expect(errorCode(new TypeError("boom"))).toBe("TypeError");
  });

  it("prefiere el código por sobre el nombre de la clase", () => {
    const err = new Error("boom") as Error & { code?: string };
    err.code = "ECONNRESET";
    expect(errorCode(err)).toBe("ECONNRESET");
  });

  it("da 'UnknownError' sin código y sin ser un Error", () => {
    expect(errorCode("boom")).toBe("UnknownError");
    expect(errorCode(null)).toBe("UnknownError");
    expect(errorCode(undefined)).toBe("UnknownError");
  });
});
