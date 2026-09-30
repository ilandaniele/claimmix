/**
 * El token firmado del formulario web (B17): ata el envío a la página que lo
 * pintó, sin guardar nada. Falla si lo forjan, lo cambian de enlace, llega
 * demasiado rápido (un bot) o demasiado tarde.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { firmarToken, verificarToken } from "@/server/web/token";

const AHORA = 1_780_000_000_000;

describe("token del formulario web", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "secreto-de-prueba-para-el-token-0123456789");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uno firmado hace cinco segundos vale para su enlace", () => {
    const token = firmarToken("mi-aseguradora", AHORA);
    expect(verificarToken(token, "mi-aseguradora", AHORA + 5_000)).toBe("ok");
  });

  it("uno recién pintado (menos de 4 s) es de un bot: muy_rapido", () => {
    const token = firmarToken("mi-aseguradora", AHORA);
    expect(verificarToken(token, "mi-aseguradora", AHORA + 1_000)).toBe("muy_rapido");
    expect(verificarToken(token, "mi-aseguradora", AHORA + 3_999)).toBe("muy_rapido");
  });

  it("uno de hace más de un día venció, y uno de hace horas todavía vale", () => {
    const token = firmarToken("mi-aseguradora", AHORA);
    expect(verificarToken(token, "mi-aseguradora", AHORA + 3 * 3_600_000)).toBe("ok");
    expect(verificarToken(token, "mi-aseguradora", AHORA + 24 * 3_600_000 - 1)).toBe("ok");
    expect(verificarToken(token, "mi-aseguradora", AHORA + 24 * 3_600_000 + 1)).toBe("vencido");
  });

  it("no sirve en otro enlace", () => {
    const token = firmarToken("mi-aseguradora", AHORA);
    expect(verificarToken(token, "otra-aseguradora", AHORA + 5_000)).toBe("invalido");
  });

  it("cambiarle la hora invalida la firma", () => {
    const token = firmarToken("mi-aseguradora", AHORA);
    const [, firma] = token.split(".");
    expect(verificarToken(`${AHORA - 60_000}.${firma}`, "mi-aseguradora", AHORA + 5_000)).toBe("invalido");
  });

  it.each([undefined, "", "abc", "1780000000000.zz", `1780000000000.${"0".repeat(64)}`])(
    "%j no es un token válido",
    (basura) => {
      expect(verificarToken(basura, "mi-aseguradora", AHORA + 5_000)).toBe("invalido");
    }
  );

  it("con otro secreto, el token de antes no vale", () => {
    const token = firmarToken("mi-aseguradora", AHORA);
    vi.stubEnv("BETTER_AUTH_SECRET", "otro-secreto-distinto-0123456789-abcdefgh");
    expect(verificarToken(token, "mi-aseguradora", AHORA + 5_000)).toBe("invalido");
  });

  it("sin BETTER_AUTH_SECRET no firma y no verifica nada", () => {
    const token = firmarToken("mi-aseguradora", AHORA);
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => firmarToken("mi-aseguradora", AHORA)).toThrow();
    expect(verificarToken(token, "mi-aseguradora", AHORA + 5_000)).toBe("invalido");
  });
});
