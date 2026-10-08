/**
 * La dirección del operador tiene que estar probada, no sólo tipeada.
 *
 * Un admin de un asegurador puede crear un usuario con cualquier dirección por
 * POST /api/admin/users, sin verificación, y ponerle una clave. Si la guarda del
 * operador comparara sólo el texto del mail, esa dirección abriría la cartera
 * de todos los clientes. Mismo criterio que provision.ts: sin emailVerified no
 * hay operador.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const { mockRequireAdmin } = vi.hoisted(() => ({ mockRequireAdmin: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));

import { requireOperator } from "@/lib/auth/require-operator";

const SAVED = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_EMAILS = "operador@example.com";
  // El operador además tiene que estar en el espacio de la casa (el de `ctx`).
  process.env.GOOGLE_DEFAULT_TENANT_ID = "t1";
});

afterEach(() => {
  process.env = { ...SAVED };
  mockRequireAdmin.mockReset();
});

function ctx(emailVerified?: boolean, email = "operador@example.com") {
  return {
    user: { id: "u1", email, emailVerified },
    userRow: { id: "u1", tenant_id: "t1", role: "admin", plan: "pro" },
  };
}

describe("requireOperator", () => {
  it("la dirección del operador sin verificar no abre la cartera", async () => {
    mockRequireAdmin.mockResolvedValue(ctx(false));
    await expect(requireOperator()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("sin el dato de verificación se trata como no verificada", async () => {
    mockRequireAdmin.mockResolvedValue(ctx(undefined));
    await expect(requireOperator()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("el operador con mail verificado pasa", async () => {
    const c = ctx(true);
    mockRequireAdmin.mockResolvedValue(c);
    await expect(requireOperator()).resolves.toBe(c);
  });

  it("un admin verificado que no es el operador no pasa", async () => {
    mockRequireAdmin.mockResolvedValue(ctx(true, "otra@example.com"));
    await expect(requireOperator()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });
});
