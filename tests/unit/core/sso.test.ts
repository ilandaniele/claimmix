/**
 * El SSO por inquilino entra con el dominio del mail. Todo lo que no sea el
 * mismo dominio, verificado por el IdP, se rechaza: un subdominio, un proveedor
 * público o un `email_verified` que no sea el booleano `true` no alcanzan.
 */

import { describe, expect, it } from "vitest";

import { dominioDelMail, dominioValido, esDominioPublico, normalizarDominio, revisarReclamos } from "@/core/sso";

describe("normalizarDominio", () => {
  it.each([
    ["Empresa.COM", "empresa.com"],
    ["  empresa.com. ", "empresa.com"],
    ["@empresa.com", "empresa.com"],
  ])("«%s» queda «%s»", (entrada, esperado) => {
    expect(normalizarDominio(entrada)).toBe(esperado);
  });
});

describe("dominioValido", () => {
  it.each(["empresa.com", "seguros.empresa.com.ar", "a-b.io"])("«%s» sí", (d) => {
    expect(dominioValido(d)).toBe(true);
  });
  it.each(["", "empresa", "-empresa.com", "empresa..com", "emp resa.com", "a@b.com", "empresa.c", "empresa.com/x", "*.empresa.com"])(
    "«%s» no",
    (d) => {
      expect(dominioValido(d)).toBe(false);
    }
  );
});

describe("dominioDelMail", () => {
  it("saca el dominio en minúscula", () => {
    expect(dominioDelMail("Ana.Perez@Empresa.COM")).toBe("empresa.com");
  });
  it("un subdominio no es el dominio", () => {
    expect(dominioDelMail("ana@sub.empresa.com")).toBe("sub.empresa.com");
    expect(dominioDelMail("ana@sub.empresa.com")).not.toBe("empresa.com");
  });
  it.each(["sin-arroba", "a@b@empresa.com", "@empresa.com", "ana@", "ana @empresa.com", "ana@empresa", ""])(
    "«%s» no tiene dominio",
    (mail) => {
      expect(dominioDelMail(mail)).toBeNull();
    }
  );
  it("no toma un valor que no es texto", () => {
    expect(dominioDelMail(null as unknown as string)).toBeNull();
  });
});

describe("esDominioPublico", () => {
  it.each(["gmail.com", "Hotmail.com", "hotmail.com.ar", "outlook.com", "yahoo.com.ar", "icloud.com", "proton.me", "live.com"])(
    "«%s» es de todos",
    (d) => {
      expect(esDominioPublico(d)).toBe(true);
    }
  );
  it.each(["empresa.com", "gmail.empresa.com", "mi-gmail.com", "seguros.com.ar"])("«%s» no", (d) => {
    expect(esDominioPublico(d)).toBe(false);
  });
});

describe("revisarReclamos", () => {
  const ok = { sub: "abc", email: "Ana@Empresa.com", email_verified: true, name: "  Ana Pérez " };

  it("mail verificado del dominio: entra, con el mail en minúscula", () => {
    expect(revisarReclamos(ok, { dominio: "empresa.com" })).toEqual({
      ok: true,
      email: "ana@empresa.com",
      sub: "abc",
      nombre: "Ana Pérez",
    });
  });

  it("acepta el dominio sin normalizar", () => {
    expect(revisarReclamos(ok, { dominio: "@Empresa.COM" }).ok).toBe(true);
  });

  it("sin nombre deja null", () => {
    expect(revisarReclamos({ ...ok, name: 7 }, { dominio: "empresa.com" })).toMatchObject({ ok: true, nombre: null });
  });

  it.each([
    [{ ...ok, email: undefined }, "sin_email"],
    [{ ...ok, email: "" }, "sin_email"],
    [{ ...ok, email: 5 }, "sin_email"],
    [{ ...ok, sub: undefined }, "sin_sub"],
    [{ ...ok, sub: "" }, "sin_sub"],
    [{ ...ok, email_verified: false }, "email_no_verificado"],
    [{ ...ok, email_verified: undefined }, "email_no_verificado"],
    [{ ...ok, email_verified: "true" }, "email_no_verificado"],
    [{ ...ok, email_verified: 1 }, "email_no_verificado"],
    [{ ...ok, email: "ana@otra.com" }, "dominio_ajeno"],
    [{ ...ok, email: "ana@sub.empresa.com" }, "dominio_ajeno"],
    [{ ...ok, email: "ana@empresa.com.evil.com" }, "dominio_ajeno"],
    [{ ...ok, email: "ana@evil.com@empresa.com" }, "dominio_ajeno"],
    [{ ...ok, email: "ana@ empresa.com" }, "dominio_ajeno"],
  ])("rechaza %j: %s", (reclamos, motivo) => {
    expect(revisarReclamos(reclamos, { dominio: "empresa.com" })).toEqual({ ok: false, motivo });
  });
});
