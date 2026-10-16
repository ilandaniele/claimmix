/**
 * Cloudflare Turnstile: existe sólo con las dos claves.
 *
 * Con una sola, o con ninguna, no hay desafío, no se llama a Cloudflare y la CSP
 * no cambia. Con las dos, cualquier falla de la verificación es un desafío no
 * pasado: un desafío que se saltea cuando Cloudflare no contesta no frena a nadie.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

import { buildCsp } from "@/lib/security/csp";
import { clavesDeTurnstile, verificarTurnstile } from "@/server/alta/turnstile";

const ORIGEN = "https://challenges.cloudflare.com";

function directiva(csp: string, nombre: string): string {
  return csp.split("; ").find((d) => d.startsWith(`${nombre} `)) ?? "";
}

const conClaves = () => {
  process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("clavesDeTurnstile", () => {
  it("sin ninguna da null", () => {
    expect(clavesDeTurnstile()).toBeNull();
  });

  it.each([["TURNSTILE_SITE_KEY"], ["TURNSTILE_SECRET_KEY"]])("sólo con %s da null", (variable) => {
    process.env[variable] = "test-turnstile-key";

    expect(clavesDeTurnstile()).toBeNull();
  });

  it("una clave en blanco cuenta como ausente", () => {
    process.env.TURNSTILE_SITE_KEY = "   ";
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";

    expect(clavesDeTurnstile()).toBeNull();
  });

  it("con las dos las devuelve", () => {
    conClaves();

    expect(clavesDeTurnstile()).toEqual({
      sitio: "test-turnstile-site-key",
      secreta: "test-turnstile-secret-key",
    });
  });
});

describe("verificarTurnstile", () => {
  it("sin claves pasa, sin llamar a nadie", async () => {
    expect(await verificarTurnstile(undefined, "203.0.113.7")).toEqual({ paso: true });
    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({ paso: true });

    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], [""], [42], [{}]])("con claves y la respuesta %j no pasa, sin llamar", async (r) => {
    conClaves();

    expect(await verificarTurnstile(r, "203.0.113.7")).toEqual({ paso: false, motivo: "sin_respuesta" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("con claves pasa sólo si Cloudflare lo confirma, con la clave secreta y la IP", async () => {
    conClaves();
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true })));

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({ paso: true });

    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe(`${ORIGEN}/turnstile/v0/siteverify`);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.body as URLSearchParams).get("secret")).toBe("test-turnstile-secret-key");
    expect((init.body as URLSearchParams).get("response")).toBe("fake-respuesta");
    expect((init.body as URLSearchParams).get("remoteip")).toBe("203.0.113.7");
  });

  it("una IP que no es una IP no viaja", async () => {
    conClaves();
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true })));

    await verificarTurnstile("fake-respuesta", "unknown");

    expect((h.fetch.mock.calls[0][1].body as URLSearchParams).has("remoteip")).toBe(false);
  });

  it.each([
    ["Cloudflare dice que no", () => new Response(JSON.stringify({ success: false })), "rechazada"],
    ["contesta sin `success`", () => new Response(JSON.stringify({})), "rechazada"],
    ["`success` no es un booleano", () => new Response(JSON.stringify({ success: "true" })), "rechazada"],
    ["contesta JSON que no es un objeto", () => new Response("null"), "rechazada"],
    ["contesta con un error", () => new Response("{}", { status: 503 }), "cloudflare_error"],
    ["contesta algo que no es JSON", () => new Response("<html>"), "cloudflare_error"],
  ])("si %s, no pasa", async (_caso, respuesta, motivo) => {
    conClaves();
    h.fetch.mockResolvedValue(respuesta());

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toMatchObject({ paso: false, motivo });
  });

  it("si Cloudflare no contesta, no pasa", async () => {
    conClaves();
    h.fetch.mockRejectedValue(new Error("timeout"));

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({
      paso: false,
      motivo: "cloudflare_no_contesta",
    });
  });

  it("un rechazo sin `error-codes` no trae `codigos`", async () => {
    conClaves();
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: false })));

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({ paso: false, motivo: "rechazada" });
  });

  it("un rechazo trae los `error-codes` de Cloudflare", async () => {
    conClaves();
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }))
    );

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({
      paso: false,
      motivo: "rechazada",
      codigos: ["timeout-or-duplicate"],
    });
  });

  it("una clave mal cargada vuelve con 400 y su código", async () => {
    conClaves();
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }), { status: 400 })
    );

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({
      paso: false,
      motivo: "cloudflare_error",
      codigos: ["invalid-input-secret"],
    });
  });

  it("`success: true` con un estado de error no pasa", async () => {
    conClaves();
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 500 }));

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({
      paso: false,
      motivo: "cloudflare_error",
    });
  });

  it("si el plazo vence mientras llega el cuerpo, Cloudflare no contestó", async () => {
    conClaves();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const respuesta = new Response("{}");
    vi.spyOn(respuesta, "json").mockRejectedValue(new DOMException("plazo", "TimeoutError"));
    h.fetch.mockResolvedValue(respuesta);

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({
      paso: false,
      motivo: "cloudflare_no_contesta",
    });
  });

  it("de `error-codes` sólo salen textos con forma de código, y como mucho cinco", async () => {
    conClaves();
    const codigos = ["a-1", 7, null, "MAYUSCULAS", "con espacio", "x".repeat(41), "b-2", "c-3", "d-4", "e-5", "f-6"];
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: false, "error-codes": codigos })));

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({
      paso: false,
      motivo: "rechazada",
      codigos: ["a-1", "b-2", "c-3", "d-4", "e-5"],
    });
  });

  it.each([
    ["no es un array", "invalid-input-secret"],
    ["es un objeto", { codigo: "invalid-input-secret" }],
    ["no tiene ningún código válido", [42, "NO VALE"]],
  ])("si `error-codes` %s, se descarta", async (_caso, errores) => {
    conClaves();
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: false, "error-codes": errores })));

    expect(await verificarTurnstile("fake-respuesta", "203.0.113.7")).toEqual({ paso: false, motivo: "rechazada" });
  });

  it("nunca devuelve la respuesta, la clave ni la IP", async () => {
    conClaves();
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] })));

    const resultado = JSON.stringify(await verificarTurnstile("fake-respuesta", "203.0.113.7"));

    expect(resultado).not.toContain("fake-respuesta");
    expect(resultado).not.toContain("test-turnstile-secret-key");
    expect(resultado).not.toContain("203.0.113.7");
  });
});

describe("la CSP", () => {
  it("sin claves no cambia: ningún origen de Cloudflare", () => {
    const csp = buildCsp("nonce-de-prueba");

    expect(csp).not.toContain("cloudflare");
    expect(directiva(csp, "script-src")).toBe("script-src 'self' 'nonce-nonce-de-prueba' 'strict-dynamic'");
    expect(directiva(csp, "frame-src")).toBe("frame-src https://www.youtube-nocookie.com");
  });

  it.each([["TURNSTILE_SITE_KEY"], ["TURNSTILE_SECRET_KEY"]])("sólo con %s tampoco", (variable) => {
    process.env[variable] = "test-turnstile-key";

    expect(buildCsp("nonce-de-prueba")).not.toContain("cloudflare");
  });

  it("con las dos claves abre el origen en script-src y en frame-src, y en ningún otro lado", () => {
    conClaves();
    const csp = buildCsp("nonce-de-prueba");

    expect(directiva(csp, "script-src")).toContain(ORIGEN);
    expect(directiva(csp, "frame-src")).toContain(ORIGEN);
    expect(directiva(csp, "frame-src")).toContain("https://www.youtube-nocookie.com");
    expect(csp.split(ORIGEN)).toHaveLength(3);
  });

  it("con las dos claves la CSP sigue sin `unsafe-inline` en los scripts", () => {
    conClaves();

    expect(directiva(buildCsp("nonce-de-prueba"), "script-src")).not.toContain("unsafe-inline");
  });
});
