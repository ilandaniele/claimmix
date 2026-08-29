/**
 * Quién puede listar clientes y pólizas.
 *
 * Los dos endpoints exponen datos personales —DNI, correo, teléfono, número de
 * póliza— así que la puerta es la misma y se prueba igual: analista fuera,
 * owner/admin/especialista adentro, sin sesión 401.
 *
 * ── Por qué estos tests afirmaban menos de lo que parecían ──────────────────
 *
 * Decían `expect(status).not.toBe(403)` para los roles permitidos. Eso lo
 * cumple también un 500: si la consulta reventaba, el test seguía en verde y el
 * reporte decía «admin puede listar clientes». Ahora se afirma 200 y se mira el
 * cuerpo.
 *
 * Y como la consulta salió del route handler, se puede espiar con qué inquilino
 * se la llamó — que es lo único que de verdad separa una aseguradora de otra.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockDb, mockGetSessionContext, mockListCustomers, mockListPolicies } =
  vi.hoisted(() => ({
    mockDb: { select: vi.fn() },
    mockGetSessionContext: vi.fn(),
    mockListCustomers: vi.fn(),
    mockListPolicies: vi.fn(),
  }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({ db: mockDb, tables: {} }));

vi.mock("@/lib/auth/session", () => ({
  getSessionContext: mockGetSessionContext,
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
  buildUserKey: vi.fn((id: string, key: string) => `${id}:${key}`),
}));

/*
 * Parciales a propósito: el esquema Zod de cada listado sale del módulo real.
 * Si se mockeara entero, el route handler validaría contra un esquema inventado
 * y el test dejaría de cubrir el parseo de parámetros.
 */
vi.mock("@/server/customers/list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/customers/list")>()),
  listCustomers: mockListCustomers,
}));

vi.mock("@/server/policies/list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/policies/list")>()),
  listPolicies: mockListPolicies,
}));

// ── Imports (después de los mocks) ────────────────────────────────────────────

import { NextRequest } from "next/server";

// ── Ayudas ────────────────────────────────────────────────────────────────────

const USER_ID = "user-uuid-001";
const TENANT_ID = "tenant-uuid-001";

const PAGINA_VACIA = {
  data: [],
  meta: { total: 0, page: 1, per_page: 25, pages: 0 },
};

function pedir(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

/** La fila de `users` que devuelve la guarda para la sesión actual. */
function conRol(role: string | null) {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi
      .fn()
      .mockResolvedValue(
        role === null ? [] : [{ id: USER_ID, role, tenant_id: TENANT_ID }]
      ),
  });
}

function conSesion(userId: string | null) {
  mockGetSessionContext.mockResolvedValue(
    userId === null ? null : { user: { id: userId, email: "test@example.com" } }
  );
}

const ENDPOINTS = [
  {
    nombre: "/api/customers",
    url: "http://localhost/api/customers",
    ruta: () => import("@/app/api/customers/route"),
    listar: mockListCustomers,
  },
  {
    nombre: "/api/policies",
    url: "http://localhost/api/policies",
    ruta: () => import("@/app/api/policies/route"),
    listar: mockListPolicies,
  },
] as const;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.each(ENDPOINTS)("GET $nombre — quién entra", ({ url, ruta, listar }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    listar.mockResolvedValue(PAGINA_VACIA);
  });

  it("un analista recibe 403 y no llega a consultar nada", async () => {
    conSesion(USER_ID);
    conRol("analyst");

    const { GET } = await ruta();
    const response = await GET(pedir(url) as never);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
    // La otra mitad: que la guarda corte ANTES de tocar los datos.
    expect(listar).not.toHaveBeenCalled();
  });

  /*
   * `owner` recibía 403 en su propia aseguradora.
   *
   * La lista de roles estaba escrita a mano en cada route —`["admin",
   * "specialist"]`— mientras el resto del producto documenta a owner como «todo
   * lo que puede hacer un admin». Nadie lo pegaba porque hoy no existe ningún
   * owner: se crea sólo por SQL directo. Era un agujero esperando al primero.
   */
  it.each(["owner", "admin", "specialist"])(
    "un %s lista y recibe 200",
    async (role) => {
      conSesion(USER_ID);
      conRol(role);

      const { GET } = await ruta();
      const response = await GET(pedir(url) as never);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: unknown[]; meta: unknown };
      expect(body.data).toEqual([]);
      expect(body.meta).toEqual(PAGINA_VACIA.meta);
    }
  );

  it("consulta con el inquilino de la sesión, no con uno de la petición", async () => {
    conSesion(USER_ID);
    conRol("admin");

    const { GET } = await ruta();
    // El parámetro se ignora: el inquilino sale de `users`, nunca de la URL.
    await GET(pedir(`${url}?tenant_id=otra-aseguradora`) as never);

    expect(listar).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      expect.objectContaining({ page: 1, per_page: 25 })
    );
  });

  it("sin sesión, 401", async () => {
    conSesion(null);

    const { GET } = await ruta();
    const response = await GET(pedir(url) as never);

    expect(response.status).toBe(401);
    expect(listar).not.toHaveBeenCalled();
  });

  it("una sesión cuyo usuario ya no está en la base también es 401", async () => {
    conSesion(USER_ID);
    conRol(null);

    const { GET } = await ruta();
    const response = await GET(pedir(url) as never);

    expect(response.status).toBe(401);
    expect(listar).not.toHaveBeenCalled();
  });
});

describe("GET /api/customers — parámetros", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCustomers.mockResolvedValue(PAGINA_VACIA);
    conSesion(USER_ID);
    conRol("admin");
  });

  it("pasa los filtros parseados al listado", async () => {
    const { GET } = await import("@/app/api/customers/route");
    await GET(
      pedir(
        "http://localhost/api/customers?search=perez&dni=30111222&email=a%40b.com&page=3&per_page=10"
      ) as never
    );

    expect(mockListCustomers).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      { search: "perez", dni: "30111222", email: "a@b.com", page: 3, per_page: 10 }
    );
  });

  it("un per_page fuera de rango es 400 y no consulta", async () => {
    const { GET } = await import("@/app/api/customers/route");
    const response = await GET(
      pedir("http://localhost/api/customers?per_page=5000") as never
    );

    expect(response.status).toBe(400);
    expect(mockListCustomers).not.toHaveBeenCalled();
  });
});

describe("GET /api/policies — parámetros", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPolicies.mockResolvedValue(PAGINA_VACIA);
    conSesion(USER_ID);
    conRol("admin");
  });

  it("pasa los filtros parseados al listado", async () => {
    const { GET } = await import("@/app/api/policies/route");
    await GET(
      pedir(
        "http://localhost/api/policies?customer_id=00000000-0000-4000-8000-000000000001&policy_number=POL-1&status=active"
      ) as never
    );

    expect(mockListPolicies).toHaveBeenCalledWith(
      { tenantId: TENANT_ID },
      {
        customer_id: "00000000-0000-4000-8000-000000000001",
        policy_number: "POL-1",
        status: "active",
        page: 1,
        per_page: 25,
      }
    );
  });

  it("un estado que no existe es 400 y no consulta", async () => {
    const { GET } = await import("@/app/api/policies/route");
    const response = await GET(
      pedir("http://localhost/api/policies?status=vencidisima") as never
    );

    expect(response.status).toBe(400);
    expect(mockListPolicies).not.toHaveBeenCalled();
  });
});
