/**
 * Que dar de alta un usuario desde el panel le deje un perfil que sirva.
 *
 * Esto no lo probaba nada, y estaba roto. La ruta hacía dos cosas: crear la
 * cuenta en Better Auth y después un UPDATE sobre `public.users` para meter a
 * la persona en el inquilino del admin. Ese UPDATE tocaba **cero filas**: el
 * hook que crea el perfil al dar de alta se saltea a quien no está en la lista
 * blanca, y alguien recién creado por un admin nunca lo está.
 *
 * El resultado era una falla perfectamente silenciosa. El admin veía "usuario
 * creado", la persona podía iniciar sesión, y no llegaba a ningún dato. Ni un
 * error en la pantalla, ni una línea en los registros.
 *
 * El test que había cubría los colores de las etiquetas de rol y el formato de
 * las fechas. Por eso el bug vivió: lo que se probaba era lo que se ve.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
vi.mock("@/data/scope", () => ({
  enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) => Promise.resolve(armar({})),
  enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) => Promise.all(armar({})),
}));

import { POST } from "@/app/api/admin/users/route";
import { NextRequest } from "next/server";

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
  mockRequireAdmin.mockResolvedValue(ADMIN);
  mockSignUp.mockResolvedValue({ user: { id: "nuevo-1" } });
  perfilCreado([{ id: "nuevo-1" }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("crear un usuario desde el panel", () => {
  it("le crea el perfil, no espera que ya exista", async () => {
    const res = await POST(pedido());

    expect(res.status).toBe(201);
    // Éste es el test que hubiera atrapado el bug: la ruta hacía UPDATE, y un
    // UPDATE sobre una fila que no existe no falla — no hace nada.
    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "nuevo-1",
        tenant_id: ADMIN.userRow.tenant_id,
        role: "analyst",
      })
    );
  });

  it("lo mete en el inquilino DEL ADMIN, no en uno que venga en el pedido", async () => {
    // Si el inquilino saliera del cuerpo, cualquier admin podría crear usuarios
    // adentro de otra aseguradora.
    await POST(pedido({ tenant_id: "bbbbbbbb-0000-0000-0000-00000000000b" }));

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: ADMIN.userRow.tenant_id })
    );
  });

  it("pisa el rol si el perfil ya existía", async () => {
    // Pasa cuando la dirección SÍ estaba en la lista blanca: el hook ya creó el
    // perfil con el rol por omisión, y lo que eligió el admin tiene que ganar.
    await POST(pedido({ role: "admin" }));

    expect(mockOnConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ role: "admin", tenant_id: ADMIN.userRow.tenant_id }),
      })
    );
  });

  it("avisa si la cuenta se creó y el perfil no", async () => {
    perfilCreado([]);

    const res = await POST(pedido());

    // Una cuenta sin perfil es peor que ninguna cuenta: el admin cree que la
    // persona ya tiene acceso, y la persona entra a una pantalla vacía sin
    // saber por qué.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const cuerpo = await res.json();
    expect(JSON.stringify(cuerpo)).toMatch(/aseguradora/i);
  });

  it("no crea nada si quien pide no es admin", async () => {
    const { AppError } = await import("@/lib/errors");
    mockRequireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    const res = await POST(pedido());

    expect(res.status).toBe(403);
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rechaza un rol que no existe sin tocar la base", async () => {
    const res = await POST(pedido({ role: "superusuario" }));

    expect(res.status).toBe(400);
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
