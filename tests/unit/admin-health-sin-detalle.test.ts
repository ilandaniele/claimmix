/**
 * `/api/admin/health` es pública. El mensaje de un error de la base puede
 * traer texto de la conexión (usuario, host) y eso es reconocimiento gratis
 * para cualquiera que la mire desde afuera. Sólo debe salir el código del
 * error, o "UNKNOWN" si no lo tiene.
 */

const { mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { select: mockSelect },
  tables: { tenants: { id: "id" } },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/admin/health/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/health — sin detalle del error de la base", () => {
  it("un error sin código da UNKNOWN, no el mensaje", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        limit: () =>
          Promise.reject(new Error("password authentication failed for user x")),
      }),
    });

    const res = await GET();
    const body = await res.json();

    expect(body.db_error).toBe("UNKNOWN");
    expect(JSON.stringify(body)).not.toMatch(/password/i);
  });

  it("un error con código conserva el código", async () => {
    const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    mockSelect.mockReturnValue({
      from: () => ({
        limit: () => Promise.reject(err),
      }),
    });

    const res = await GET();
    const body = await res.json();

    expect(body.db_error).toBe("ECONNREFUSED");
  });
});
