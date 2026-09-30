/**
 * La prueba de dominio del SSO: un TXT que sólo se puede calcular con el secreto
 * de la app, atado al inquilino y al dominio.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PREFIJO_DEL_TXT, registroDeVerificacion, tokenDeVerificacion, txtProbado } from "@/server/sso/dominio";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

describe("prueba de dominio", () => {
  beforeEach(() => vi.stubEnv("BETTER_AUTH_SECRET", "secreto-de-prueba-para-sso-0123456789"));
  afterEach(() => vi.unstubAllEnvs());

  it("el token es base64url de 32 bytes y estable", () => {
    const t = tokenDeVerificacion(T1, "empresa.com");
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenDeVerificacion(T1, "empresa.com")).toBe(t);
  });

  it("depende del inquilino, del dominio y del secreto", () => {
    const base = tokenDeVerificacion(T1, "empresa.com");
    expect(tokenDeVerificacion(T2, "empresa.com")).not.toBe(base);
    expect(tokenDeVerificacion(T1, "otra.com")).not.toBe(base);
    vi.stubEnv("BETTER_AUTH_SECRET", "otro-secreto-distinto-0123456789-abcdef");
    expect(tokenDeVerificacion(T1, "empresa.com")).not.toBe(base);
  });

  it("normaliza el dominio antes de firmar", () => {
    expect(tokenDeVerificacion(T1, "  Empresa.COM ")).toBe(tokenDeVerificacion(T1, "empresa.com"));
  });

  it("sin BETTER_AUTH_SECRET no hay token", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => tokenDeVerificacion(T1, "empresa.com")).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("el registro se publica en _claimmix.<dominio>", () => {
    const r = registroDeVerificacion(T1, "Empresa.com");
    expect(r.nombre).toBe("_claimmix.empresa.com");
    expect(r.valor).toBe(`${PREFIJO_DEL_TXT}${tokenDeVerificacion(T1, "empresa.com")}`);
  });

  it("txtProbado acepta el registro propio, aun partido en trozos", () => {
    const { valor } = registroDeVerificacion(T1, "empresa.com");
    expect(txtProbado([["v=spf1 -all"], [valor]], T1, "empresa.com")).toBe(true);
    expect(txtProbado([[valor.slice(0, 30), valor.slice(30)]], T1, "empresa.com")).toBe(true);
  });

  it("txtProbado rechaza el de otro inquilino, el de otro dominio y lo vacío", () => {
    const ajeno = registroDeVerificacion(T2, "empresa.com").valor;
    const otroDominio = registroDeVerificacion(T1, "otra.com").valor;
    expect(txtProbado([[ajeno]], T1, "empresa.com")).toBe(false);
    expect(txtProbado([[otroDominio]], T1, "empresa.com")).toBe(false);
    expect(txtProbado([], T1, "empresa.com")).toBe(false);
    expect(txtProbado([[""]], T1, "empresa.com")).toBe(false);
  });
});
