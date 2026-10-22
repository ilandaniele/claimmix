/**
 * `direccionCanonica`: la dirección como se cuenta en un tope por destinatario.
 * Gmail se arma por partes: el chequeo de datos personales marca cualquier
 * casilla de Gmail escrita entera.
 */

import { describe, expect, it } from "vitest";

import { direccionCanonica } from "@/core/email/direccion-canonica";

const gmail = (local: string, dominio = "gmail.com") => `${local}@${dominio}`;

describe("direccionCanonica", () => {
  it("recorta, pasa a minúsculas y corta el +etiqueta en cualquier dominio", () => {
    expect(direccionCanonica("  Ana+Pruebas@Example.com ")).toBe("ana@example.com");
    expect(direccionCanonica("ana+a+b@example.org")).toBe("ana@example.org");
  });

  it("en otros dominios deja los puntos de la parte local", () => {
    expect(direccionCanonica("an.a@example.com")).toBe("an.a@example.com");
  });

  it("en Gmail saca también los puntos, y googlemail es gmail", () => {
    const esperada = gmail("anaperez");
    expect(direccionCanonica(gmail("Ana.Perez+x"))).toBe(esperada);
    expect(direccionCanonica(gmail("an.a.p.erez", "googlemail.com"))).toBe(esperada);
  });

  it("no valida: lo que el patrón de quien llama deja pasar (apóstrofe) se cuenta igual", () => {
    expect(direccionCanonica("o'brien+1@example.com")).toBe("o'brien@example.com");
  });

  it("null si no queda parte local o no hay arroba", () => {
    expect(direccionCanonica("+1@example.com")).toBeNull();
    expect(direccionCanonica(gmail("..+x"))).toBeNull();
    expect(direccionCanonica("@example.com")).toBeNull();
    expect(direccionCanonica("sin-arroba")).toBeNull();
    expect(direccionCanonica("")).toBeNull();
  });
});
