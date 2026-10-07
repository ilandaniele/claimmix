/**
 * `/change-password` y `/verify-password` en la ruta de Better Auth.
 *
 * Los dos reciben una contraseña —la actual— de quien tiene una sesión, y el
 * limitador de Better Auth cuenta en memoria por instancia: en serverless cada
 * instancia lleva su cuenta y el techo no es uno. Una cookie robada alcanzaba
 * para adivinar la contraseña sin freno determinista.
 *
 * `/verify-password` la app no lo usa: se niega. `/change-password` lleva un
 * cupo en Postgres por usuario, no por IP: la cookie robada es un usuario.
 *
 * `/sign-up/email` tampoco se usa por HTTP (el alta es `/registro`, que llama a
 * Better Auth desde el servidor): se niega, y con eso nadie pre-registra una
 * dirección permitida ni lee la lista por la forma de la respuesta.
 */

import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRateLimit, mockTopePorIp, mockGetSession, handlerPost } = vi.hoisted(() => ({
  mockRateLimit: vi.fn(),
  mockTopePorIp: vi.fn(),
  mockGetSession: vi.fn(),
  handlerPost: vi.fn(),
}));

const SIN_CUPO = () => ({
  allowed: false,
  remaining: 0,
  resetAt: Date.now() + 20_000,
  retryAfterSeconds: 20,
});
const CON_CUPO = () => ({ allowed: true, remaining: 4, resetAt: Date.now() + 20_000, retryAfterSeconds: 0 });

async function cargarRuta() {
  vi.resetModules();
  vi.doMock("better-auth/next-js", () => ({
    toNextJsHandler: () => ({ GET: vi.fn(), POST: handlerPost }),
  }));
  vi.doMock("@/lib/auth", () => ({ auth: { api: { getSession: mockGetSession } } }));
  vi.doMock("@/lib/rate-limit/index", async (original) => ({
    ...(await original<typeof import("@/lib/rate-limit/index")>()),
    rateLimit: mockRateLimit,
    topePorIp: mockTopePorIp,
  }));
  const ruta = await import("@/app/api/auth/[...all]/route");
  const { RATE_LIMIT_CONFIGS } = await import("@/lib/rate-limit/index");
  return { POST: ruta.POST, RATE_LIMIT_CONFIGS };
}

const pedido = (ruta: string, cuerpo: object = { currentPassword: "fake-pass", newPassword: "fake-new-pass" }) =>
  new NextRequest(`http://x/api/auth/${ruta}`, {
    method: "POST",
    body: JSON.stringify(cuerpo),
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": "1.2.3.4" },
  });

beforeEach(() => {
  mockRateLimit.mockReset();
  mockTopePorIp.mockReset();
  mockGetSession.mockReset();
  handlerPost.mockReset();
  handlerPost.mockResolvedValue(new Response("ok", { status: 200 }));
});

describe("POST /api/auth/verify-password", () => {
  it("es un oráculo de contraseña que la app no usa: 404 sin tocar Better Auth", async () => {
    const { POST } = await cargarRuta();

    const res = await POST(pedido("verify-password", { password: "fake-pass" }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(handlerPost).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/sign-up/email", () => {
  it("el alta es /registro, desde el servidor: por HTTP es 404, sin cupo ni Better Auth", async () => {
    const { POST } = await cargarRuta();

    const res = await POST(pedido("sign-up/email", { name: "Ana", email: "ana@example.com", password: "fake-pass" }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(handlerPost).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/change-password", () => {
  it("con sesión y sin cupo: 429 con Retry-After, sin tocar Better Auth", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u-1" }, session: {} });
    mockRateLimit.mockResolvedValue(SIN_CUPO());
    const { POST, RATE_LIMIT_CONFIGS } = await cargarRuta();

    const req = pedido("change-password");
    const res = await POST(req);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    expect(handlerPost).not.toHaveBeenCalled();
    expect(mockRateLimit).toHaveBeenCalledWith("user:u-1:change-password", RATE_LIMIT_CONFIGS.AUTH_CAMBIO_CLAVE);
    expect(mockTopePorIp).not.toHaveBeenCalled();
    expect(mockGetSession).toHaveBeenCalledWith({ headers: req.headers });
  });

  it("sin sesión: pasa a Better Auth, que contesta 401, y no gasta cupo", async () => {
    mockGetSession.mockResolvedValue(null);
    const { POST } = await cargarRuta();

    await POST(pedido("change-password"));

    expect(handlerPost).toHaveBeenCalledTimes(1);
    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  it("con sesión y cupo: pasa a Better Auth y devuelve lo que éste conteste", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u-1" }, session: {} });
    mockRateLimit.mockResolvedValue(CON_CUPO());
    handlerPost.mockResolvedValue(new Response("cambiada", { status: 200 }));
    const { POST } = await cargarRuta();

    const res = await POST(pedido("change-password"));

    expect(handlerPost).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cambiada");
  });
});

describe("POST /api/auth/sign-in/email", () => {
  it("sigue yendo por IP y dirección: 429 sin leer la sesión", async () => {
    mockRateLimit.mockResolvedValue(SIN_CUPO());
    mockTopePorIp.mockResolvedValue(CON_CUPO());
    const { POST } = await cargarRuta();

    const res = await POST(pedido("sign-in/email", { email: "a@b.com", password: "fake-pass" }));

    expect(res.status).toBe(429);
    expect(handlerPost).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});
