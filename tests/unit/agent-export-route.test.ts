/**
 * GET /api/agent/export: la sesión y el cupo van antes de mirar los parámetros.
 *
 * Sin sesión la ruta contesta 401 aunque los parámetros estén mal formados; con
 * sesión, un parámetro inválido es 400; pasado el cupo es 429 y no se arma nada.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEntrar, mockBuild, mockCanExport, mockAudit } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockBuild: vi.fn(),
  mockCanExport: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  ALL_ROLES: (await import("@/lib/auth/roles")).ALL_ROLES,
}));
vi.mock("@/lib/rate-limit/index", () => ({
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
}));
vi.mock("@/lib/audit/log", () => ({
  AuditEvent: { AGENT_MEMORY_CONFIG_EXPORTED: "agent.memory_config_exported" },
  writeAuditLog: mockAudit,
}));
vi.mock("@/server/agents/export", () => ({
  AGENT_EXPORT_TYPES: ["config_only", "memory_only", "full"],
  AGENT_EXPORT_PII_MODES: ["masked", "excluded", "full_admin_only"],
  normalizeAgentExportFormat: (raw: string | null) => (raw === "json" ? "json" : null),
  canExportAgentData: mockCanExport,
  buildAgentMemoryConfigExport: mockBuild,
  buildApprovedExamplesCsvSummary: vi.fn(),
  buildApprovedExamplesJsonl: vi.fn(),
  loadApprovedExamplesForExport: vi.fn(),
}));

import { AppError } from "@/lib/errors";
import { ALL_ROLES } from "@/lib/auth/roles";
import { GET } from "@/app/api/agent/export/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";

const dentro = (rl = { allowed: true, remaining: 10, resetAt: 0, retryAfterSeconds: 0 }) => ({
  ctx: { user: { id: "u-1" }, userRow: { id: "u-1", tenant_id: TENANT_ID, role: "admin" } },
  rl,
});

const pedir = (qs = "") => GET(new Request(`http://localhost/api/agent/export${qs}`));

beforeEach(() => {
  mockEntrar.mockResolvedValue(dentro());
  mockCanExport.mockReturnValue(true);
  mockBuild.mockResolvedValue({ ok: true });
  mockAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/agent/export", () => {
  it("pasa por la puerta común, con el cupo de los casos y todos los roles", async () => {
    const res = await pedir();

    expect(res.status).toBe(200);
    expect(mockEntrar).toHaveBeenCalledWith("agent-export", { limit: 100, windowMs: 60_000 }, ...ALL_ROLES);
  });

  it("sin sesión da 401 aunque los parámetros estén mal", async () => {
    mockEntrar.mockRejectedValue(new AppError("MISSING_SESSION"));

    expect((await pedir("?type=cualquiera&format=xml")).status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("con sesión, un parámetro inválido da 400 y no arma nada", async () => {
    const res = await pedir("?type=cualquiera");

    expect(res.status).toBe(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("pasado el cupo da 429 sin mirar los parámetros ni armar nada", async () => {
    mockEntrar.mockResolvedValue(dentro({ allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 30 }));

    expect((await pedir("?type=cualquiera")).status).toBe(429);
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("un rol sin permiso para ese export da 403", async () => {
    mockCanExport.mockReturnValue(false);

    expect((await pedir()).status).toBe(403);
    expect(mockBuild).not.toHaveBeenCalled();
  });
});
