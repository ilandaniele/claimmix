/**
 * `autenticacionFallida` (E17) — sólo spf=fail/softfail o dkim=fail sin un
 * dkim=pass al lado cuentan como falla; todo lo demás, incluida la ausencia
 * de la cabecera, no falló.
 */

import { describe, it, expect } from "vitest";
import { autenticacionFallida, ORIGEN_WEB } from "@/core/email/autenticacion";

const cab = (name: string, value: string) => [{ name, value }];

describe("autenticacionFallida", () => {
  it("spf=pass y dkim=pass no fallan", () => {
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; spf=pass smtp.mailfrom=x@y; dkim=pass header.i=@y"))).toBe(false);
  });

  it("sin cabecera, arreglo vacío o null no fallan", () => {
    expect(autenticacionFallida(undefined)).toBe(false);
    expect(autenticacionFallida([])).toBe(false);
    expect(autenticacionFallida(null)).toBe(false);
  });

  it("WhatsApp guarda {} y no una lista: no falló", () => {
    expect(autenticacionFallida({})).toBe(false);
  });

  it("spf=none, spf=neutral y dkim=temperror no fallan", () => {
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; spf=none"))).toBe(false);
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; spf=neutral"))).toBe(false);
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; dkim=temperror"))).toBe(false);
  });

  it("spf=fail falla", () => {
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; spf=fail smtp.mailfrom=x@y"))).toBe(true);
  });

  it("spf=softfail falla", () => {
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; spf=softfail smtp.mailfrom=x@y"))).toBe(true);
  });

  it("dkim=fail falla", () => {
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; dkim=fail header.i=@y"))).toBe(true);
  });

  it("dkim=fail al lado de un dkim=pass no falla", () => {
    expect(autenticacionFallida(cab("Authentication-Results", "mx.google.com; dkim=fail header.i=@a; dkim=pass header.i=@b"))).toBe(false);
  });

  it("el formulario web (B17) cuenta como no verificado: cualquiera puede escribir cualquier correo ahí", () => {
    expect(autenticacionFallida([ORIGEN_WEB])).toBe(true);
    expect(autenticacionFallida(cab("x-claimmix-origen", "WEB"))).toBe(true);
    expect(autenticacionFallida(cab("X-ClaimMix-Origen", "otro"))).toBe(false);
  });

  it("mira el nombre de la cabecera sin importar mayúsculas", () => {
    expect(autenticacionFallida(cab("AUTHENTICATION-RESULTS", "mx.google.com; spf=fail"))).toBe(true);
  });

  it("ARC-Authentication-Results sola no cuenta", () => {
    expect(autenticacionFallida(cab("ARC-Authentication-Results", "mx.google.com; spf=fail smtp.mailfrom=x@y"))).toBe(false);
  });

  it("dos cabeceras, una con fail, falla", () => {
    expect(
      autenticacionFallida([
        { name: "Received-SPF", value: "fail" },
        { name: "Authentication-Results", value: "mx.google.com; spf=fail" },
      ])
    ).toBe(true);
  });
});
