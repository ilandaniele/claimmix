/**
 * Empezar el ingreso con el SSO de la empresa (B19): `urlDelSso` y la acción
 * `signInSso` de la pantalla de entrada.
 *
 * Todo lo que puede salir mal da la misma respuesta (`null`, y en el login el
 * mismo código de error): desde afuera no se puede averiguar qué aseguradoras
 * usan la plataforma. Y como los Server Actions llaman a Better Auth sin pasar por
 * la ruta HTTP, los topes tienen que estar acá, antes de salir a la red.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { signInSsoInquilino, rateLimit, topePorIp, loggerError, cabeceras } = vi.hoisted(() => ({
  signInSsoInquilino: vi.fn(),
  rateLimit: vi.fn(),
  topePorIp: vi.fn(),
  loggerError: vi.fn(),
  cabeceras: new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "user-agent": "vitest" }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => cabeceras }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { signInSsoInquilino } } }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/rate-limit/index", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit/index")>()),
  rateLimit,
  topePorIp,
}));
// Lo demás de las acciones del login no entra en juego acá: que no abra una conexión.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ writeAuditLog: vi.fn(), AuditEvent: {} }));

import { signInSso } from "@/app/login/actions";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { urlDelSso } from "@/server/sso/ingreso";

const PERMITIDO = { allowed: true, remaining: 3, resetAt: 0 };
const DENEGADO = { allowed: false, remaining: 0, resetAt: 0 };
const IDP = "https://idp.empresa.com/authorize?client_id=c&state=abc";

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue(PERMITIDO);
  topePorIp.mockResolvedValue(PERMITIDO);
  signInSsoInquilino.mockResolvedValue({ url: IDP });
});

describe("urlDelSso", () => {
  it("devuelve la dirección del IdP y le pasa a Better Auth el correo, los dos retornos y las cabeceras", async () => {
    await expect(urlDelSso("ana@empresa.com", "/bandeja", "/login")).resolves.toBe(IDP);

    expect(signInSsoInquilino).toHaveBeenCalledWith({
      body: { email: "ana@empresa.com", callbackURL: "/bandeja", errorCallbackURL: "/login" },
      headers: cabeceras,
    });
  });

  it("recorta los espacios del correo antes de todo", async () => {
    await urlDelSso("  ana@empresa.com ", "/bandeja", "/login");

    expect(signInSsoInquilino.mock.calls[0]![0].body.email).toBe("ana@empresa.com");
    expect(rateLimit.mock.calls[0]![0]).toBe(claveDeCupo("auth:sso", "203.0.113.9", "ana@empresa.com"));
  });

  it("cuenta dos topes —por (IP, correo) y por IP sola— con los mismos perfiles que el ingreso con contraseña", async () => {
    await urlDelSso("ana@empresa.com", "/bandeja", "/login");

    expect(rateLimit).toHaveBeenCalledWith(claveDeCupo("auth:sso", "203.0.113.9", "ana@empresa.com"), RATE_LIMIT_CONFIGS.AUTH_SIGN_IN);
    expect(topePorIp).toHaveBeenCalledWith("203.0.113.9");
  });

  it("el cupo del SSO es aparte del de la contraseña: agotar uno no agota el otro", () => {
    expect(claveDeCupo("auth:sso", "203.0.113.9", "ana@empresa.com")).not.toBe(
      claveDeCupo("auth:in", "203.0.113.9", "ana@empresa.com")
    );
  });

  it.each([
    ["el tope por correo", () => rateLimit.mockResolvedValue(DENEGADO)],
    ["el tope por IP", () => topePorIp.mockResolvedValue(DENEGADO)],
  ])("pasado %s devuelve null y no sale a la red", async (_nombre, agotar) => {
    agotar();

    await expect(urlDelSso("ana@empresa.com", "/bandeja", "/login")).resolves.toBeNull();
    expect(signInSsoInquilino).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "ab", "a".repeat(255) + "@empresa.com"])("el correo %j da null sin gastar cupo ni llamar a nadie", async (correo) => {
    await expect(urlDelSso(correo, "/bandeja", "/login")).resolves.toBeNull();

    expect(rateLimit).not.toHaveBeenCalled();
    expect(topePorIp).not.toHaveBeenCalled();
    expect(signInSsoInquilino).not.toHaveBeenCalled();
  });

  it("si Better Auth no tiene dirección (dominio sin SSO, sin verificar, apagado) devuelve null", async () => {
    signInSsoInquilino.mockResolvedValue({ url: null });

    await expect(urlDelSso("ana@otra.com", "/bandeja", "/login")).resolves.toBeNull();
  });

  it("si Better Auth tira, devuelve null y deja el rastro sin el detalle en la respuesta", async () => {
    signInSsoInquilino.mockRejectedValue(new Error("fallo interno del IdP"));

    await expect(urlDelSso("ana@empresa.com", "/bandeja", "/login")).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith({ detalle: "fallo interno del IdP" }, "auth.sso.signin_start_failed");
  });

  it("una respuesta sin `url` también es null", async () => {
    signInSsoInquilino.mockResolvedValue({});

    await expect(urlDelSso("ana@empresa.com", "/bandeja", "/login")).resolves.toBeNull();
  });
});

describe("signInSso (la acción del login)", () => {
  const formulario = (email?: string) => {
    const form = new FormData();
    if (email !== undefined) form.set("email", email);
    return form;
  };
  const destino = async (accion: Promise<void>) => {
    try {
      await accion;
    } catch (e) {
      return (e as Error).message.replace(/^REDIRECT:/, "");
    }
    throw new Error("no redirigió");
  };

  it("con dirección del IdP, redirige ahí; vuelve a /bandeja al entrar y a /login si hay un error", async () => {
    await expect(destino(signInSso(formulario("ana@empresa.com")))).resolves.toBe(IDP);

    expect(signInSsoInquilino.mock.calls[0]![0].body).toEqual({
      email: "ana@empresa.com",
      callbackURL: "/bandeja",
      errorCallbackURL: "/login",
    });
  });

  it("sin dirección vuelve a /login con el código genérico, sea cual sea la causa", async () => {
    signInSsoInquilino.mockResolvedValue({ url: null });
    await expect(destino(signInSso(formulario("ana@otra.com")))).resolves.toBe("/login?error=sso_fallo");

    signInSsoInquilino.mockRejectedValue(new Error("x"));
    await expect(destino(signInSso(formulario("ana@empresa.com")))).resolves.toBe("/login?error=sso_fallo");

    rateLimit.mockResolvedValue(DENEGADO);
    await expect(destino(signInSso(formulario("ana@empresa.com")))).resolves.toBe("/login?error=sso_fallo");
  });

  it("sin el campo del correo no llega a Better Auth", async () => {
    await expect(destino(signInSso(formulario()))).resolves.toBe("/login?error=sso_fallo");

    expect(signInSsoInquilino).not.toHaveBeenCalled();
  });
});
