/**
 * `claveDeCupo` es la única forma de escribir la clave de un cupo (E21).
 *
 * Acá sólo van los casos puros de la función: sin mocks, sin importar nada
 * de infraestructura. Los casos de formulario-y-API que comparten cubeta
 * (login, reset, alta) están más abajo, en el mismo archivo.
 *
 * El caso de WhatsApp nunca usa el teléfono real: E12 hashea antes de armar
 * la clave, así que el número no queda en claro en `rate_limit_counters`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { claveDeCupo } from "@/lib/rate-limit/clave";

describe("claveDeCupo", () => {
  it("uno de usuario es user:<id>:<etiqueta>", () => {
    expect(claveDeCupo("user", "u-1", "cases-list")).toBe("user:u-1:cases-list");
  });

  it("uno por IP es auth:ip:<ip>", () => {
    expect(claveDeCupo("auth:ip", "1.2.3.4")).toBe("auth:ip:1.2.3.4");
  });

  it("recorta espacios y pasa a minúsculas cada parte", () => {
    expect(claveDeCupo("auth:in", "1.2.3.4", " Ana@Ejemplo.COM ")).toBe(
      "auth:in:1.2.3.4:ana@ejemplo.com"
    );
  });

  it("una parte vacía deja el separador final", () => {
    expect(claveDeCupo("auth:in", "1.2.3.4", "")).toBe("auth:in:1.2.3.4:");
  });

  it("demo público es demo-public:<ip>", () => {
    expect(claveDeCupo("demo-public", "1.2.3.4")).toBe("demo-public:1.2.3.4");
  });

  it("batch-simulate es batch-simulate:<userId>", () => {
    expect(claveDeCupo("batch-simulate", "u-1")).toBe("batch-simulate:u-1");
  });

  it("las lecturas y subidas de documentos (B6, B21) cuentan por póliza y por caso, no por usuario", () => {
    expect(claveDeCupo("condiciones-poliza", "T-1", "P-1")).toBe("condiciones-poliza:t-1:p-1");
    expect(claveDeCupo("lectura-presupuesto", "t-1", "c-1")).toBe("lectura-presupuesto:t-1:c-1");
    expect(claveDeCupo("subida-condiciones", "T-1", "P-1")).toBe("subida-condiciones:t-1:p-1");
  });

  it("re-analyze es re-analyze:<caseId>:<userId>", () => {
    expect(claveDeCupo("re-analyze", "c-1", "u-1")).toBe("re-analyze:c-1:u-1");
  });

  // Nunca el teléfono real: 5490000000001 es de prueba.
  it("whatsapp junta las partes con dos puntos, como cualquier otro ámbito", () => {
    expect(claveDeCupo("whatsapp", "t-1", "5490000000001")).toBe(
      "whatsapp:t-1:5490000000001"
    );
  });

  it("la clave de un remitente de WhatsApp (E12, O2) es «whatsapp:» más 32 hex, sin el teléfono", () => {
    const huella = createHash("sha256")
      .update("t-1:whatsapp:5490000000001")
      .digest("hex")
      .slice(0, 32);
    const clave = claveDeCupo("whatsapp", huella);
    expect(clave).toMatch(/^whatsapp:[0-9a-f]{32}$/);
    expect(clave).not.toContain("5490000000001");
  });
});

/**
 * El formulario y la ruta HTTP comparten cubeta.
 *
 * Antes cada uno armaba la clave a mano y las dos formas de escribir
 * `auth:in:…` eran dos cupos distintos: alguien podía agotar el del
 * formulario y seguir probando por la API con el cupo entero disponible.
 * Ahora los dos caminos llaman a `claveDeCupo` con las mismas partes, y esto
 * lo comprueba leyendo la clave con la que cada uno llama a `rateLimit`.
 */
const { mockRateLimit, mockTopePorIp } = vi.hoisted(() => ({
  mockRateLimit: vi.fn(),
  mockTopePorIp: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-vercel-forwarded-for": "1.2.3.4", "user-agent": "t" }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({ GET: vi.fn(), POST: vi.fn(async () => new Response("ok")) }),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      signInEmail: vi.fn(),
      requestPasswordReset: vi.fn(),
      signUpEmail: vi.fn(),
    },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ resolveDefaultTenantId: () => null }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ users: {} }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn(),
  AuditEvent: { AUTH_RATE_LIMITED: "auth.rate_limited", AUTH_SIGN_UP: "auth.sign_up" },
}));
vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: mockRateLimit,
  topePorIp: mockTopePorIp,
}));

describe("el formulario y la API comparten cubeta (E21)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 1_000,
      retryAfterSeconds: 1,
    });
    mockTopePorIp.mockResolvedValue({ allowed: true, remaining: 29, resetAt: 0, retryAfterSeconds: 0 });
  });

  it("login: signIn y POST /api/auth/sign-in/email arman la misma clave", async () => {
    const { signIn } = await import("@/app/login/actions");
    const { POST } = await import("@/app/api/auth/[...all]/route");

    const fd = new FormData();
    fd.set("email", "Ana@Ejemplo.com");
    fd.set("password", "cualquier-cosa");
    await signIn({}, fd);
    const claveFormulario = mockRateLimit.mock.calls[0][0];

    mockRateLimit.mockClear();
    await POST(
      new NextRequest("http://x/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email: "Ana@Ejemplo.com", password: "x" }),
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": "1.2.3.4" },
      })
    );
    const claveApi = mockRateLimit.mock.calls[0][0];

    expect(claveFormulario).toBe("auth:in:1.2.3.4:ana@ejemplo.com");
    expect(claveApi).toBe("auth:in:1.2.3.4:ana@ejemplo.com");
  });

  it("reset: pedirEnlace y POST /api/auth/request-password-reset arman la misma clave", async () => {
    const { pedirEnlace } = await import("@/app/recuperar/actions");
    const { POST } = await import("@/app/api/auth/[...all]/route");

    const fd = new FormData();
    fd.set("email", "Ana@Ejemplo.com");
    await pedirEnlace({}, fd);
    const claveFormulario = mockRateLimit.mock.calls[0][0];

    mockRateLimit.mockClear();
    await POST(
      new NextRequest("http://x/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({ email: "Ana@Ejemplo.com" }),
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": "1.2.3.4" },
      })
    );
    const claveApi = mockRateLimit.mock.calls[0][0];

    expect(claveFormulario).toBe("auth:reset:1.2.3.4:ana@ejemplo.com");
    expect(claveApi).toBe("auth:reset:1.2.3.4:ana@ejemplo.com");
  });

  it("alta: signUp y POST /api/auth/sign-up/email arman la misma clave, y signUp también cuenta por IP sola", async () => {
    const { signUp } = await import("@/app/registro/actions");
    const { POST } = await import("@/app/api/auth/[...all]/route");

    const fd = new FormData();
    fd.set("full_name", "Ana Pérez");
    fd.set("email", "Ana@Ejemplo.com");
    fd.set("password", "una-contraseña-larga");
    await signUp({}, fd);
    const claveFormulario = mockRateLimit.mock.calls[0][0];

    expect(mockTopePorIp).toHaveBeenCalledWith("1.2.3.4");

    mockRateLimit.mockClear();
    await POST(
      new NextRequest("http://x/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ email: "Ana@Ejemplo.com", password: "x" }),
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": "1.2.3.4" },
      })
    );
    const claveApi = mockRateLimit.mock.calls[0][0];

    expect(claveFormulario).toBe("auth:up:1.2.3.4");
    expect(claveApi).toBe("auth:up:1.2.3.4");
  });
});
