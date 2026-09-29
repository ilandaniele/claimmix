/**
 * GET /api/cases/:id y la opinión de responsabilidad (B18).
 *
 * La ruta arma la respuesta desde la fila entera del caso, así que la columna
 * nueva viajaría a cualquier rol. La opinión es orientativa y del equipo que
 * edita el caso: un viewer no la recibe. `entrar` se reemplaza por uno que
 * cumple su contrato para probar qué deja pasar la RUTA.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockEntrar, mockDetalle, sesion } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockDetalle: vi.fn(),
  sesion: { rol: "analyst" as string },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
  CASE_EDITOR_ROLES: (await import("@/lib/auth/roles")).CASE_EDITOR_ROLES,
}));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/server/cases/get", () => ({ getCaseDetail: mockDetalle }));
vi.mock("@/server/cases/patch", () => ({ patchCase: vi.fn() }));
vi.mock("@/server/cases/delete", () => ({ deleteCases: vi.fn() }));
vi.mock("@/lib/rate-limit/index", () => ({
  getClientIp: () => "127.0.0.1",
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
}));

import { GET } from "@/app/api/cases/[id]/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const OPINION = {
  v: 1,
  responsable: "tercero",
  regla: "ley24449_art48g",
  motivo: { clave: "alcance", params: { parte: "tercero" } },
  faltantes: [],
  difiere: false,
};

function llamar() {
  return GET(new NextRequest(`http://localhost/api/cases/${CASE_ID}`, { headers: { "user-agent": "vitest" } }), {
    params: Promise.resolve({ id: CASE_ID }),
  });
}

describe("GET /api/cases/:id — responsabilidad", () => {
  beforeEach(() => {
    sesion.rol = "analyst";
    mockEntrar.mockImplementation(async () => ({
      ctx: {
        user: { id: "u1" },
        userRow: { id: "u1", tenant_id: "t1", role: sesion.rol, plan: "profesional" },
      },
      rl: { allowed: true, remaining: 10, retryAfterSeconds: 0 },
    }));
    mockDetalle.mockResolvedValue({
      case: { id: CASE_ID, confidence_min: "0.8", responsabilidad: OPINION },
      extracted_fields: [],
      missing_docs: [],
      audit_log: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["owner", "admin", "specialist", "analyst"])("%s recibe la opinión", async (rol) => {
    sesion.rol = rol;
    const cuerpo = await (await llamar()).json();
    expect(cuerpo.case.responsabilidad).toEqual(OPINION);
  });

  it("un viewer no la recibe, ni la clave", async () => {
    sesion.rol = "viewer";
    const respuesta = await llamar();
    expect(respuesta.status).toBe(200);
    const data = await respuesta.json();
    expect(data.case).not.toHaveProperty("responsabilidad");
    expect(JSON.stringify(data)).not.toContain("24449");
    expect(data.case.confidence_min).toBe(0.8);
  });
});
