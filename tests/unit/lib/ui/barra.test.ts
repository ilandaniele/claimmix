/**
 * La cookie de la barra lateral: el cliente la escribe, el servidor la lee en
 * el layout para pintar la barra ya contraída, sin parpadeo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: h.get }) }));

import { leerBarraContraida } from "../../../../src/lib/ui/barra";
import { BARRA_COOKIE, cookieDeLaBarra } from "../../../../src/lib/ui/barra-shared";

beforeEach(() => vi.clearAllMocks());

describe("cookieDeLaBarra", () => {
  it("contraída escribe 1, a todo el sitio y por un año", () => {
    expect(cookieDeLaBarra(true)).toBe(`${BARRA_COOKIE}=1; path=/; max-age=31536000; SameSite=Lax`);
  });

  it("expandida escribe 0: la elección queda recordada, no se borra", () => {
    expect(cookieDeLaBarra(false)).toBe(`${BARRA_COOKIE}=0; path=/; max-age=31536000; SameSite=Lax`);
  });
});

describe("leerBarraContraida", () => {
  it("con la cookie en 1 la barra arranca contraída", async () => {
    h.get.mockReturnValue({ value: "1" });

    expect(await leerBarraContraida()).toBe(true);
    expect(h.get).toHaveBeenCalledWith(BARRA_COOKIE);
  });

  it.each([["0"], ["true"], [""], ["basura"]])("con %j la barra arranca abierta", async (value) => {
    h.get.mockReturnValue({ value });

    expect(await leerBarraContraida()).toBe(false);
  });

  it("sin cookie la barra arranca abierta", async () => {
    h.get.mockReturnValue(undefined);

    expect(await leerBarraContraida()).toBe(false);
  });
});
