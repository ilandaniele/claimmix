/**
 * PATCH/DELETE /api/admin/gmail-accounts: 404 y 400 en vez de 500.
 *
 * Un id inexistente en el PATCH, un id que no es uuid en el DELETE, y un JSON
 * roto en el PATCH tiraban una excepción sin capturar que terminaba en 500.
 *
 * El PATCH además acomoda el aviso (watch) de Gmail: apagar la casilla lo
 * detiene y prenderla lo vuelve a registrar. Un fallo del watch no cambia el
 * 200, y el token cifrado que viaja en el RETURNING nunca sale en la respuesta.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockRequireRole, mockEnControl, mockStop, mockSetup, mockDecrypt } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockEnControl: vi.fn(),
  mockStop: vi.fn(),
  mockSetup: vi.fn(),
  mockDecrypt: vi.fn(),
}));

vi.mock("@/server/email/gmail/watch", () => ({
  stopGmailWatch: mockStop,
  setupGmailWatch: mockSetup,
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  decryptRefreshToken: mockDecrypt,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: mockRequireRole,
  ADMIN_ROLES: ["owner", "admin"],
  ALL_ROLES: ["owner", "admin", "analyst", "supervisor", "viewer"],
}));

vi.mock("@/data/scope", () => ({
  enControl: mockEnControl,
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
        refresh_token_encrypted: col("refresh_token_encrypted"),
        tenant_id: col("tenant_id"),
        connected_by: col("connected_by"),
      },
    },
  };
});

import { PATCH, DELETE } from "@/app/api/admin/gmail-accounts/route";

const USER_ROW = { id: "user-1", tenant_id: "tenant-1", role: "admin" as const };
const ID = "10000000-0000-0000-0000-000000000001";
const TOPIC = "projects/claimmix-test/topics/gmail-push";
const FILA = {
  id: ID,
  email: "casilla@example.com",
  enabled: true,
  last_connected_at: null,
  last_error: null,
  created_at: "2026-10-01T00:00:00.000Z",
  refresh_token_encrypted: "fake-cifrado",
};

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
  mockDecrypt.mockReturnValue("fake-refresh");
  mockStop.mockResolvedValue(undefined);
  mockSetup.mockResolvedValue({ historyId: "1", expiration: "2026-10-08T00:00:00.000Z" });
  process.env.PUBSUB_TOPIC = TOPIC;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.PUBSUB_TOPIC;
  vi.restoreAllMocks();
});

describe("PATCH /api/admin/gmail-accounts", () => {
  it("da 404 con un id inexistente", async () => {
    mockEnControl.mockResolvedValue([]);

    const res = await PATCH(patchRequest(JSON.stringify({ id: ID, enabled: true })));

    expect(res.status).toBe(404);
  });

  it("da 400 con un JSON roto", async () => {
    const res = await PATCH(patchRequest("{ esto no es json"));

    expect(res.status).toBe(400);
    expect(mockEnControl).not.toHaveBeenCalled();
  });

  it("da 200 con un id existente", async () => {
    mockEnControl.mockResolvedValue([FILA]);

    const res = await PATCH(patchRequest(JSON.stringify({ id: ID, enabled: true })));

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/admin/gmail-accounts — el aviso de Gmail", () => {
  const patch = (enabled: boolean) => PATCH(patchRequest(JSON.stringify({ id: ID, enabled })));

  it("apagar la casilla detiene el watch con su token descifrado", async () => {
    mockEnControl.mockResolvedValue([{ ...FILA, enabled: false }]);

    const res = await patch(false);

    expect(res.status).toBe(200);
    expect(mockDecrypt).toHaveBeenCalledWith("fake-cifrado");
    expect(mockStop).toHaveBeenCalledWith({ email: "casilla@example.com", refreshToken: "fake-refresh" });
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("apagar la casilla detiene el watch aunque no haya PUBSUB_TOPIC", async () => {
    delete process.env.PUBSUB_TOPIC;
    mockEnControl.mockResolvedValue([{ ...FILA, enabled: false }]);

    await patch(false);

    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("prenderla con PUBSUB_TOPIC vuelve a registrar el watch", async () => {
    mockEnControl.mockResolvedValue([FILA]);

    const res = await patch(true);

    expect(res.status).toBe(200);
    expect(mockSetup).toHaveBeenCalledWith(TOPIC, { email: "casilla@example.com", refreshToken: "fake-refresh" });
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("prenderla sin PUBSUB_TOPIC no toca el watch", async () => {
    delete process.env.PUBSUB_TOPIC;
    mockEnControl.mockResolvedValue([FILA]);

    const res = await patch(true);

    expect(res.status).toBe(200);
    expect(mockSetup).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["detener", false, () => mockStop],
    ["registrar", true, () => mockSetup],
  ])("si falla al %s el watch, igual da 200 y la casilla queda como se pidió", async (_nombre, enabled, queFalla) => {
    mockEnControl.mockResolvedValue([{ ...FILA, enabled }]);
    queFalla().mockRejectedValue(Object.assign(new Error("se cayó Google"), { code: 503 }));

    const res = await patch(enabled);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).not.toHaveProperty("watch");
    expect(data.account.enabled).toBe(enabled);
  });

  it("si el token no se puede descifrar, da 200 sin llamar a Google", async () => {
    mockEnControl.mockResolvedValue([FILA]);
    mockDecrypt.mockImplementation(() => {
      throw new Error("Invalid Gmail token payload");
    });

    const res = await patch(true);

    expect(res.status).toBe(200);
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("la respuesta trae sólo la casilla: sin token cifrado ni descifrado, ni el estado del watch", async () => {
    mockEnControl.mockResolvedValue([FILA]);

    const res = await patch(true);

    const cuerpo = await res.json();
    expect(Object.keys(cuerpo)).toEqual(["account"]);
    const texto = JSON.stringify(cuerpo);
    expect(texto).not.toContain("refresh_token_encrypted");
    expect(texto).not.toContain("fake-cifrado");
    expect(texto).not.toContain("fake-refresh");
  });

  it("el log del fallo lleva el código y no el token ni la casilla", async () => {
    const { logger } = await import("@/lib/observability/logger");
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    mockEnControl.mockResolvedValue([FILA]);
    mockSetup.mockRejectedValue(Object.assign(new Error("fake-refresh casilla@example.com"), { code: 503 }));

    await patch(true);

    expect(error).toHaveBeenCalledWith({ detalle: 503 }, "gmail_accounts.watch_no_cambiado");
  });

  it("sin fila (404) no toca el watch", async () => {
    mockEnControl.mockResolvedValue([]);

    const res = await patch(false);

    expect(res.status).toBe(404);
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockSetup).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/gmail-accounts", () => {
  it("da 404 si el id no es uuid", async () => {
    const res = await DELETE(deleteRequest("no-es-un-uuid"));

    expect(res.status).toBe(404);
    expect(mockEnControl).not.toHaveBeenCalled();
  });

  it("da 404 si no viene el id", async () => {
    const res = await DELETE(deleteRequest());

    expect(res.status).toBe(404);
    expect(mockEnControl).not.toHaveBeenCalled();
  });

  it("da 404 si el uuid no matchea ninguna fila", async () => {
    mockEnControl.mockResolvedValue([]);

    const res = await DELETE(deleteRequest(ID));

    expect(res.status).toBe(404);
  });

  it("borra con un uuid existente", async () => {
    mockEnControl.mockResolvedValue([{ id: ID }]);

    const res = await DELETE(deleteRequest(ID));

    expect(res.status).toBe(200);
  });
});
