/**
 * `GET /api/cases/export.csv` — status/type/severity/channel son multi-select.
 *
 * Mismo cambio que en `GET /api/cases` (ver
 * `cases-route-filtros-multiples.test.ts`): `getAll(k)` en vez de `get(k)`
 * para los cuatro filtros repetibles. `parsed.data.status/type/severity/
 * channel` ya salen del esquema como array, así que esta ruta los reenvía a
 * `listCasesForExport` sin convertir nada — lo que prueba el último test de
 * este archivo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockEntrar, mockListCasesForExport } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockListCasesForExport: vi.fn(),
}));

vi.mock("@/lib/api/entrada", () => ({
  entrar: mockEntrar,
}));

vi.mock("@/server/cases/list", () => ({
  listCasesForExport: mockListCasesForExport,
}));

// getServerLocale lee la cookie del pedido vía next/headers — fuera de
// alcance de un pedido real acá. El idioma no es lo que este test cubre.
vi.mock("@/lib/i18n/locale", () => ({
  getServerLocale: vi.fn().mockResolvedValue("es-AR"),
}));

import { GET } from "@/app/api/cases/export.csv/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function makeRequest(qs: string) {
  return new NextRequest(`http://localhost/api/cases/export.csv${qs}`);
}

describe("GET /api/cases/export.csv — filtros multi-select", () => {
  beforeEach(() => {
    mockEntrar.mockResolvedValue({
      ctx: {
        user: { id: USER_ID },
        userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin" },
      },
      rl: { allowed: true, remaining: 10, retryAfterSeconds: 0 },
    });
    mockListCasesForExport.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dos valores del mismo parámetro llegan los dos a la consulta", async () => {
    const res = await GET(makeRequest("?type=choque&type=robo"));

    expect(res.status).toBe(200);
    expect(mockListCasesForExport).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ type: ["choque", "robo"] })
    );
  });

  it("un valor solo sigue funcionando", async () => {
    const res = await GET(makeRequest("?type=choque"));

    expect(res.status).toBe(200);
    expect(mockListCasesForExport).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ type: ["choque"] })
    );
  });

  it("un valor inválido entre válidos da 400", async () => {
    const res = await GET(makeRequest("?type=choque&type=no-existe"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(mockListCasesForExport).not.toHaveBeenCalled();
  });

  it("status/type/severity/channel llegan a listCasesForExport ya como array, sin convertir", async () => {
    const res = await GET(
      makeRequest("?status=listo&severity=high&severity=critical&channel=email")
    );

    expect(res.status).toBe(200);
    expect(mockListCasesForExport).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        status: ["listo"],
        severity: ["high", "critical"],
        channel: ["email"],
      })
    );
  });
});
