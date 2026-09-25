/**
 * `GET /api/cases` — status/type/severity/channel son multi-select.
 *
 * Antes leía cada uno con `searchParams.get(k)`, que sólo ve el último valor
 * de la URL. Ahora usa `getAll(k)`: junta los repetidos (`?type=choque&type=
 * robo`) en un array, y para un valor solo (`?type=choque`) da `["choque"]`,
 * que es lo que `CaseQuerySchema` ya esperaba de un valor suelto.
 *
 * El esquema en sí (uno, varios, vacío, inválido) ya tiene su test en
 * `el-filtro-acepta-varios-valores.test.ts`. Esto prueba la RUTA: que lo que
 * llega por query string efectivamente cruza a `listCases` como array, y que
 * un valor inválido entre válidos sigue dando el mismo 400 de siempre.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockEntrar, mockListCases, mockDeleteCases } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockListCases: vi.fn(),
  mockDeleteCases: vi.fn(),
}));

vi.mock("@/lib/api/entrada", () => ({
  entrar: mockEntrar,
}));

vi.mock("@/server/cases/list", () => ({
  listCases: mockListCases,
}));

vi.mock("@/server/cases/delete", () => ({
  deleteCases: mockDeleteCases,
}));

import { GET } from "@/app/api/cases/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function makeRequest(qs: string) {
  return new NextRequest(`http://localhost/api/cases${qs}`);
}

describe("GET /api/cases — filtros multi-select", () => {
  beforeEach(() => {
    mockEntrar.mockResolvedValue({
      ctx: {
        user: { id: USER_ID },
        userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin" },
      },
      rl: { allowed: true, remaining: 10, retryAfterSeconds: 0 },
    });
    mockListCases.mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, per_page: 25, pages: 0 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dos valores del mismo parámetro llegan los dos a la consulta", async () => {
    const res = await GET(makeRequest("?type=choque&type=robo"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ type: ["choque", "robo"] })
    );
  });

  it("un valor solo sigue funcionando", async () => {
    const res = await GET(makeRequest("?type=choque"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ type: ["choque"] })
    );
  });

  it("un valor inválido entre válidos da 400", async () => {
    const res = await GET(makeRequest("?type=choque&type=no-existe"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(mockListCases).not.toHaveBeenCalled();
  });

  it("«Para responder» llega a la consulta", async () => {
    const res = await GET(makeRequest("?para_responder=true"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ para_responder: true })
    );
  });

  it.each(["false", ""])("para_responder=%s no da 400: no filtra", async (valor) => {
    const res = await GET(makeRequest(`?para_responder=${valor}`));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ para_responder: undefined })
    );
  });
});
