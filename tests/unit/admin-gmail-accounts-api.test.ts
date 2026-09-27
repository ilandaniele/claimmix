/**
 * PATCH/DELETE /api/admin/gmail-accounts: 404 y 400 en vez de 500.
 *
 * Un id inexistente en el PATCH, un id que no es uuid en el DELETE, y un JSON
 * roto en el PATCH tiraban una excepción sin capturar que terminaba en 500.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockRequireRole, mockEnTenant } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockEnTenant: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: mockRequireRole,
  ADMIN_ROLES: ["owner", "admin"],
  ALL_ROLES: ["owner", "admin", "analyst", "supervisor", "viewer"],
}));

vi.mock("@/data/scope", () => ({
  enTenant: mockEnTenant,
}));

vi.mock("@/lib/db", () => {
  const col = (name: string) => ({ name });
  return {
    tables: {
      gmailAccounts: {
        id: col("id"),
        email: col("email"),
        enabled: col("enabled"),
        last_connected_at: col("last_connected_at"),
        last_error: col("last_error"),
        created_at: col("created_at"),
        tenant_id: col("tenant_id"),
        connected_by: col("connected_by"),
      },
    },
  };
});

import { PATCH, DELETE } from "@/app/api/admin/gmail-accounts/route";

const USER_ROW = { id: "user-1", tenant_id: "tenant-1", role: "admin" as const };
const ID = "10000000-0000-0000-0000-000000000001";

function patchRequest(body: string) {
  return new NextRequest("http://localhost/api/admin/gmail-accounts", {
    method: "PATCH",
    body,
    headers: { "content-type": "application/json" },
  });
}

function deleteRequest(id?: string) {
  const url = id
    ? `http://localhost/api/admin/gmail-accounts?id=${encodeURIComponent(id)}`
    : "http://localhost/api/admin/gmail-accounts";
  return new NextRequest(url, { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ user: { id: USER_ROW.id }, userRow: USER_ROW });
});

describe("PATCH /api/admin/gmail-accounts", () => {
  it("da 404 con un id inexistente", async () => {
    mockEnTenant.mockResolvedValue([]);

    const res = await PATCH(patchRequest(JSON.stringify({ id: ID, enabled: true })));

    expect(res.status).toBe(404);
  });

  it("da 400 con un JSON roto", async () => {
    const res = await PATCH(patchRequest("{ esto no es json"));

    expect(res.status).toBe(400);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("da 200 con un id existente", async () => {
    mockEnTenant.mockResolvedValue([{ id: ID, email: "a@b.com", enabled: true }]);

    const res = await PATCH(patchRequest(JSON.stringify({ id: ID, enabled: true })));

    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/gmail-accounts", () => {
  it("da 404 si el id no es uuid", async () => {
    const res = await DELETE(deleteRequest("no-es-un-uuid"));

    expect(res.status).toBe(404);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("da 404 si no viene el id", async () => {
    const res = await DELETE(deleteRequest());

    expect(res.status).toBe(404);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("da 404 si el uuid no matchea ninguna fila", async () => {
    mockEnTenant.mockResolvedValue([]);

    const res = await DELETE(deleteRequest(ID));

    expect(res.status).toBe(404);
  });

  it("borra con un uuid existente", async () => {
    mockEnTenant.mockResolvedValue([{ id: ID }]);

    const res = await DELETE(deleteRequest(ID));

    expect(res.status).toBe(200);
  });
});
