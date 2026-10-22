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
  desdeDePeriodo: (p?: string) => (p ? `desde-${p}` : undefined),
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
      expect.objectContaining({ type: ["choque", "robo"] }),
      USER_ID
    );
  });

  it("un valor solo sigue funcionando", async () => {
    const res = await GET(makeRequest("?type=choque"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ type: ["choque"] }),
      USER_ID
    );
  });

  it("el período llega a la consulta como fecha de inicio", async () => {
    const res = await GET(makeRequest("?periodo=7d"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ periodo: "7d", desde: "desde-7d" }),
      USER_ID
    );
  });

  it("sin período no hay fecha de inicio", async () => {
    await GET(makeRequest("?type=choque"));

    expect(mockListCases.mock.calls[0][1].desde).toBeUndefined();
  });

  it("un período que no existe da 400", async () => {
    const res = await GET(makeRequest("?periodo=siempre"));

    expect(res.status).toBe(400);
    expect(mockListCases).not.toHaveBeenCalled();
  });

  it("un valor inválido entre válidos da 400", async () => {
    const res = await GET(makeRequest("?type=choque&type=no-existe"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(mockListCases).not.toHaveBeenCalled();
  });

  it("fraude llega a la consulta (G35)", async () => {
    const res = await GET(makeRequest("?fraude=high"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ fraude: ["high"] }),
      USER_ID
    );
  });

  it("plazo y complejidad llegan a la consulta como arrays (B10, B13)", async () => {
    const res = await GET(makeRequest("?vencimiento=vencidos&vencimiento=por_vencer&complejidad=alta"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ vencimiento: ["vencidos", "por_vencer"], complejidad: ["alta"] }),
      USER_ID
    );
  });

  it.each(["vencimiento=mañana", "complejidad=altisima", "sort=puntaje"])("%s da 400", async (qs) => {
    const res = await GET(makeRequest(`?${qs}`));

    expect(res.status).toBe(400);
    expect(mockListCases).not.toHaveBeenCalled();
  });

  it.each(["puntaje_complejidad", "vence_en"])("ordenar por %s llega a la consulta", async (sort) => {
    const res = await GET(makeRequest(`?sort=${sort}&order=asc`));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ sort, order: "asc" }),
      USER_ID
    );
  });

  it("«Para responder» llega a la consulta", async () => {
    const res = await GET(makeRequest("?para_responder=true"));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ para_responder: true }),
      USER_ID
    );
  });

  it.each(["false", ""])("para_responder=%s no da 400: no filtra", async (valor) => {
    const res = await GET(makeRequest(`?para_responder=${valor}`));

    expect(res.status).toBe(200);
    expect(mockListCases).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ para_responder: undefined }),
      USER_ID
    );
  });
});
