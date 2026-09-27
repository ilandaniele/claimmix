/**
 * `resolveAccountLocale`: la preferencia de la cuenta le gana a la cookie del
 * dispositivo, para que la persona vea sus pantallas en su idioma en
 * cualquier lugar donde entre. Sin preferencia guardada, o con un valor que
 * no es ninguno de los soportados, manda la cookie (o el default si tampoco
 * hay cookie).
 */

import { describe, it, expect, vi } from "vitest";

const { mockCookies } = vi.hoisted(() => ({ mockCookies: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: mockCookies }));

import { resolveAccountLocale } from "@/lib/i18n/locale";

function conCookie(valor: string | undefined) {
  mockCookies.mockResolvedValueOnce({
    get: (nombre: string) => (nombre === "locale" && valor !== undefined ? { value: valor } : undefined),
  });
}

describe("resolveAccountLocale", () => {
  it("la cuenta en 'en-US' le gana a la cookie en 'es-AR'", async () => {
    conCookie("es-AR");
    expect(await resolveAccountLocale("en-US")).toBe("en-US");
  });

  it("la cuenta en 'es-AR' le gana a la cookie en 'en-US'", async () => {
    conCookie("en-US");
    expect(await resolveAccountLocale("es-AR")).toBe("es-AR");
  });

  it("sin preferencia de cuenta (null), cae a la cookie", async () => {
    conCookie("en-US");
    expect(await resolveAccountLocale(null)).toBe("en-US");
  });

  it("sin preferencia de cuenta (undefined), cae a la cookie", async () => {
    conCookie("en-US");
    expect(await resolveAccountLocale()).toBe("en-US");
  });

  it("una preferencia de cuenta inválida cae a la cookie", async () => {
    conCookie("en-US");
    expect(await resolveAccountLocale("fr-FR")).toBe("en-US");
  });

  it("sin cuenta ni cookie, cae al default", async () => {
    conCookie(undefined);
    expect(await resolveAccountLocale(null)).toBe("es-AR");
  });
});
