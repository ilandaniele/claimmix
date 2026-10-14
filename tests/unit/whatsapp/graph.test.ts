/**
 * Lo que comparten los tres clientes de Graph: la forma de la ruta. Nada que llegue
 * como ruta puede cambiar el host, salir de la versión ni colar otro camino.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clienteDeGraph, rutaDeGraph, SIN_PEDIDO } from "@/server/whatsapp/graph";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rutaDeGraph", () => {
  it.each([
    "debug_token",
    "oauth/access_token",
    "200000000000002/subscribed_apps",
    "100000000000777?fields=display_phone_number,verified_name",
    "100000000000777/whatsapp_business_profile?fields=description,email,vertical",
    "debug_token?input_token=fake-client-token.0123_456",
    "200000000000002?fields=health_status&appsecret_proof=0a1b",
  ])("deja pasar %s tal cual", (ruta) => {
    expect(rutaDeGraph(ruta)).toBe(ruta);
  });

  it.each([
    "",
    "/",
    "/200000000000002",
    "200000000000002/",
    "//evil.example/200000000000002",
    "https://evil.example/200000000000002",
    "../../v1/200000000000002",
    "200000000000002/../otra",
    "200000000000002@evil.example",
    "200000000000002#x",
    "200000000000002?fields=a#x",
    "200000000000002?fields=a?b",
    "200000000000002?fields=a/b",
    "200000000000002/subscribed_apps/mas",
    "2000000 00000002",
    "200000000000002?fields=a b",
    "200000000000002%2F..",
  ])("rechaza %j", (ruta) => {
    expect(rutaDeGraph(ruta)).toBeNull();
  });
});

describe("clienteDeGraph", () => {
  it("con una ruta sin forma de Graph no llama a fetch: es un pedido que ni salió", async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);
    const { llamar } = clienteDeGraph<"paso">("test.graph");
    await expect(llamar("paso", "200000000000002/../otra", { autorizacion: "Bearer fake-token" })).resolves.toEqual({
      ok: false,
      falla: SIN_PEDIDO,
    });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});
