/**
 * Un admin de aseguradora no puede dar de alta la dirección de quien opera la plataforma.
 *
 * `POST /api/admin/users` es el único que llama a `enAltaDeAdmin`, que se salta
 * `SIGNUP_ALLOWED_EMAILS`, y aceptaba cualquier dirección: también una de
 * `ADMIN_EMAILS`, que abren la cartera de todas las aseguradoras. La negativa
 * tiene que ir antes de la cuenta y antes del perfil: sin fila en ningún lado.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockRequireAdmin, mockSignUp, mockInsert, mockValues, mockOnConflict, mockReturning } =
  vi.hoisted(() => ({
    mockRequireAdmin: vi.fn(),
    mockSignUp: vi.fn(),
    mockInsert: vi.fn(),
    mockValues: vi.fn(),
    mockOnConflict: vi.fn(),
    mockReturning: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("@/lib/auth", () => ({ auth: { api: { signUpEmail: mockSignUp } } }));
vi.mock("@/lib/db", () => ({ db: { insert: mockInsert } }));
vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", tenant_id: "tenant_id", full_name: "full_name", role: "role" },
  authUsers: { id: "id", role: "role" },
}));
vi.mock("@/data/scope", async () => (await import("../mocks/puente-de-alcance")).puenteDeAlcance(() => ({})));
vi.mock("@/lib/i18n/locale", () => ({
  resolveAccountLocale: vi.fn().mockResolvedValue("es-AR"),
}));

import { POST } from "@/app/api/admin/users/route";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { NextRequest } from "next/server";

const SAVED = { ...process.env };

const ADMIN = {
  userRow: { id: "admin-1", tenant_id: "aaaaaaaa-0000-0000-0000-00000000000a", role: "admin" },
  user: { id: "admin-1", email: "jefa@seguros.com.ar" },
};

/** El pedido tal como lo manda la pantalla. */
function pedido(over: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Lucía Fernández",
      email: "lucia@seguros.com.ar",
      role: "analyst",
      ...over,
    }),
  });
}

/** Qué devuelve la cadena de inserción del perfil. */
function perfilCreado(filas: unknown[]) {
  mockReturning.mockResolvedValue(filas);
  mockOnConflict.mockReturnValue({ returning: mockReturning });
  mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflict });
  mockInsert.mockReturnValue({ values: mockValues });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "operador@example.com";
  mockRequireAdmin.mockResolvedValue(ADMIN);
  mockSignUp.mockResolvedValue({ user: { id: "nuevo-1" } });
  perfilCreado([{ id: "nuevo-1" }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("alta de la dirección del operador desde el panel", () => {
  it("la rechaza, con otra capitalización también, sin crear cuenta ni perfil", async () => {
    const res = await POST(pedido({ email: "Operador@Example.com", role: "admin" }));

    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.error.code).toBe("VALIDATION_FAILED");
    expect(cuerpo.error.message).toBe(esARServidor["usuarios.error.operador"]);
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("deja dar de alta a cualquier otra dirección", async () => {
    const res = await POST(pedido());

    expect(res.status).toBe(201);
    expect(mockSignUp).toHaveBeenCalledOnce();
  });

  it("sin operador configurado no rechaza nada", async () => {
    delete process.env.ADMIN_EMAILS;

    const res = await POST(pedido({ email: "operador@example.com" }));

    expect(res.status).toBe(201);
    expect(mockSignUp).toHaveBeenCalledOnce();
  });
});
