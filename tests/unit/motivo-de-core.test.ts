/**
 * Los códigos de fallo de la entrega (`core_error_message`, el motivo de la
 * prueba) se leen en el idioma de la cuenta; nunca sale el código crudo.
 */

import { describe, expect, it } from "vitest";

import { getT, type Locale } from "@/lib/i18n";
import { textoDelMotivo } from "@/lib/i18n/motivo-de-core";

const CODIGOS = ["timeout", "red", "destino_rechazado", "redireccion", "http_502"];

describe.each<Locale>(["es-AR", "en-US"])("textoDelMotivo (%s)", (locale) => {
  const t = getT(locale);

  it.each(CODIGOS)("%s tiene su texto", (codigo) => {
    const texto = textoDelMotivo(t, codigo);
    expect(texto).not.toContain(codigo);
    expect(texto).not.toBe(t("core.motivo.otro"));
    expect(texto).not.toMatch(/^core\.motivo\./);
  });

  // El plazo vive en PLAZO_MS (real.ts); un número acá queda viejo cuando cambie.
  it("timeout no repite el plazo", () => {
    expect(textoDelMotivo(t, "timeout")).not.toMatch(/\d/);
  });

  it("http_<n> lleva el código de estado", () => {
    expect(textoDelMotivo(t, "http_502")).toContain("502");
    expect(textoDelMotivo(t, "http_502")).not.toContain("{n}");
  });

  it.each([null, undefined, "", "Simulated core system timeout", "constructor", "http_5000"])(
    "%s da el texto genérico",
    (motivo) => {
      expect(textoDelMotivo(t, motivo)).toBe(t("core.motivo.otro"));
    }
  );
});
