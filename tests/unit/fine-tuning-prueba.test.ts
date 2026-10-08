/**
 * El ajuste fino en prueba (P10): crear, empezar o sincronizar un entrenamiento
 * responde 403 PLAN_SIN_ENTRENAMIENTO cuando el espacio salió del alta
 * automática y sigue en prueba. Listar no cambia.
 *
 * Lo que decide es la fila de la sesión (`billing_status` + `autoalta`), nunca
 * el cuerpo del pedido: por eso `requireAdmin` va mockeado con distintas filas
 * y el resto de la ruta corre de verdad.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockRequireAdmin, mockCrearBorrador, mockListar, vertex } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockCrearBorrador: vi.fn(),
  mockListar: vi.fn(),
  vertex: {
    listar: vi.fn(),
    borrador: vi.fn(),
    empezar: vi.fn(),
    sincronizar: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("@/server/training/fine-tuning", () => ({
  createDraftFineTuneJob: mockCrearBorrador,
  listFineTuneJobs: mockListar,
}));
vi.mock("@/server/training/vertex-ai-fine-tuning", () => ({
  listVertexAiTuningJobs: vertex.listar,
  createVertexAiTuningDraft: vertex.borrador,
  startVertexAiTuningJob: vertex.empezar,
  syncVertexAiTuningJobStatus: vertex.sincronizar,
  getVertexAiConfig: () => ({}),
}));

import * as jobs from "@/app/api/admin/fine-tuning/jobs/route";
import * as vertexRoute from "@/app/api/admin/fine-tuning/vertex/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const JOB_ID = "30000000-0000-0000-0000-000000000001";

const FILA = { id: USER_ID, tenant_id: TENANT_ID, role: "admin", plan: "piloto" };
const EN_PRUEBA = { ...FILA, billing_status: "trial", autoalta: true };

function sesion(userRow: Record<string, unknown>) {
  mockRequireAdmin.mockResolvedValue({ user: { id: USER_ID }, userRow });
}

function pedido(ruta: "jobs" | "vertex", cuerpo: unknown) {
  return new NextRequest(`http://localhost/api/admin/fine-tuning/${ruta}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
}

const ACCIONES_DE_VERTEX = [
  { action: "draft" },
  { action: "start", jobId: JOB_ID },
  { action: "sync", jobId: JOB_ID },
];

function nadaDeEntrenamiento() {
  expect(mockCrearBorrador).not.toHaveBeenCalled();
  expect(vertex.borrador).not.toHaveBeenCalled();
  expect(vertex.empezar).not.toHaveBeenCalled();
  expect(vertex.sincronizar).not.toHaveBeenCalled();
}

describe("ajuste fino en prueba", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCrearBorrador.mockResolvedValue({ id: JOB_ID });
    mockListar.mockResolvedValue([]);
    vertex.borrador.mockResolvedValue({ id: JOB_ID });
    vertex.empezar.mockResolvedValue({ id: JOB_ID });
    vertex.sincronizar.mockResolvedValue({ id: JOB_ID });
    vertex.listar.mockResolvedValue([]);
    sesion(EN_PRUEBA);
  });

  it("jobs: crear el borrador en prueba da 403 PLAN_SIN_ENTRENAMIENTO y no toca nada", async () => {
    const res = await jobs.POST(pedido("jobs", { action: "draft" }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PLAN_SIN_ENTRENAMIENTO");
    nadaDeEntrenamiento();
  });

  it.each(ACCIONES_DE_VERTEX)("vertex: $action en prueba da 403 PLAN_SIN_ENTRENAMIENTO y no toca nada", async (cuerpo) => {
    const res = await vertexRoute.POST(pedido("vertex", cuerpo));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PLAN_SIN_ENTRENAMIENTO");
    nadaDeEntrenamiento();
  });

  it("corta antes de leer el cuerpo: un cuerpo inválido tampoco filtra nada distinto", async () => {
    const res = await vertexRoute.POST(pedido("vertex", { action: "borrar" }));

    expect(res.status).toBe(403);
  });

  it("listar sigue andando en prueba", async () => {
    expect((await jobs.GET()).status).toBe(200);
    expect((await vertexRoute.GET()).status).toBe(200);
  });

  it.each([
    ["un inquilino de siempre, sin las columnas de la prueba", FILA],
    ["un inquilino de siempre en 'trial' (el valor por omisión)", { ...FILA, billing_status: "trial", autoalta: false }],
    ["antes de la 0048, con autoalta nula", { ...FILA, billing_status: "trial", autoalta: null }],
    ["un alta automática que ya paga", { ...FILA, billing_status: "active", autoalta: true }],
  ])("%s: entrena como siempre", async (_nombre, fila) => {
    sesion(fila);

    expect((await jobs.POST(pedido("jobs", { action: "draft" }))).status).toBe(201);
    expect((await vertexRoute.POST(pedido("vertex", { action: "draft" }))).status).toBe(201);
    expect(mockCrearBorrador).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(vertex.borrador).toHaveBeenCalledWith(TENANT_ID, USER_ID);
  });

  it("el cuerpo no abre nada: lo que diga el pedido no cambia la respuesta", async () => {
    const res = await jobs.POST(pedido("jobs", { action: "draft", autoalta: false, billing_status: "active" }));

    expect(res.status).toBe(403);
    nadaDeEntrenamiento();
  });
});
