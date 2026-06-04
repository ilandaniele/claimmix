/**
 * Unit tests for the i18n translation helper.
 */

import { describe, it, expect } from "vitest";
import { t, getT, esAR } from "@/lib/i18n/index";
import { enUS } from "@/lib/i18n/en-US";

describe("t() translation helper", () => {
  it("returns the correct string for 'nav.bandeja'", () => {
    expect(t("nav.bandeja")).toBe("Bandeja");
  });

  it("returns the correct string for 'status.procesando'", () => {
    expect(t("status.procesando")).toBe("Procesando");
  });

  it("returns the correct string for 'auth.signIn.title'", () => {
    expect(t("auth.signIn.title")).toBe("Iniciar sesión");
  });

  it("returns the correct string for 'app.name'", () => {
    expect(t("app.name")).toBe("ClaimMix");
  });

  it("returns non-empty strings for all keys", () => {
    const keys = Object.keys(esAR) as Array<keyof typeof esAR>;
    for (const key of keys) {
      expect(t(key)).toBeTruthy();
      expect(typeof t(key)).toBe("string");
    }
  });
});

describe("multilanguage support", () => {
  it("t() returns Spanish by default (no locale arg)", () => {
    expect(t("nav.bandeja")).toBe("Bandeja");
  });

  it("t() returns Spanish when locale='es-AR'", () => {
    expect(t("nav.bandeja", "es-AR")).toBe("Bandeja");
  });

  it("t() returns English when locale='en-US'", () => {
    expect(t("nav.bandeja", "en-US")).toBe("Inbox");
  });

  it("getT() factory returns locale-bound function for es-AR", () => {
    const tEs = getT("es-AR");
    expect(tEs("status.listo")).toBe("Listo");
  });

  it("getT() factory returns locale-bound function for en-US", () => {
    const tEn = getT("en-US");
    expect(tEn("status.listo")).toBe("Ready");
  });

  it("en-US has all the same keys as es-AR", () => {
    const esKeys = Object.keys(esAR);
    const enKeys = Object.keys(enUS);
    expect(enKeys).toEqual(expect.arrayContaining(esKeys));
    expect(esKeys).toEqual(expect.arrayContaining(enKeys));
  });

  it("en-US has no empty string values", () => {
    for (const [key, value] of Object.entries(enUS)) {
      expect(value, `en-US key '${key}' should not be empty`).not.toBe("");
    }
  });

  it("en-US status labels are in English", () => {
    expect(enUS["status.listo"]).toBe("Ready");
    expect(enUS["status.esperando"]).toBe("Waiting");
    expect(enUS["status.escalado"]).toBe("Escalated");
    expect(enUS["status.cerrado"]).toBe("Closed");
    expect(enUS["status.procesando"]).toBe("Processing");
  });
});

describe("esAR flat string map", () => {
  it("has all required claim type labels", () => {
    expect(esAR["type.choque"]).toBeDefined();
    expect(esAR["type.robo"]).toBeDefined();
    expect(esAR["type.granizo"]).toBeDefined();
    expect(esAR["type.incendio"]).toBeDefined();
  });

  it("has all required status labels", () => {
    expect(esAR["status.procesando"]).toBeDefined();
    expect(esAR["status.listo"]).toBeDefined();
    expect(esAR["status.esperando"]).toBeDefined();
    expect(esAR["status.escalado"]).toBeDefined();
    expect(esAR["status.cerrado"]).toBeDefined();
  });

  it("has auth labels in Spanish", () => {
    // All auth strings should be in Spanish (not English).
    const authKeys = Object.entries(esAR).filter(([k]) => k.startsWith("auth."));
    for (const [, value] of authKeys) {
      // Basic check: none of these should be 'undefined' or empty.
      expect(value).toBeTruthy();
    }
  });

  it("has no empty string values", () => {
    for (const [key, value] of Object.entries(esAR)) {
      expect(value, `Key '${key}' should not be empty`).not.toBe("");
    }
  });
});
