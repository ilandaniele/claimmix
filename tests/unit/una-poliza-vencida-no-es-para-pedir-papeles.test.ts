/**
 * Una póliza que ya venció se deriva sola.
 *
 * `mirarPolizas` (src/core/case/poliza-vigente.ts) decide `derivar: true`
 * cuando la persona dio un número, el padrón lo tiene, y ninguna de las
 * pólizas encontradas está vigente. El worker pasa ese veredicto en
 * `extractedOutput.polizas`, y de acá para abajo camina por el MISMO
 * `escalate()` que usa la severidad: un especialista se entera, y al
 * asegurado no se le pide documentación que no le va a servir de nada.
 *
 * Mocks copiados de orchestrate-post-extraction.test.ts (líneas 1-110): sin
 * eso, `db` pide DATABASE_URL al importarse y el test ni arranca.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";
import type { CustomerMatch } from "@/server/matching/customer-matcher";

// ── Module mocks (mismo patrón que orchestrate-post-extraction.test.ts) ───────

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };
  return { db: mockDb, tables: {} };
});

vi.mock("@/lib/db/helpers", () => ({
  firstRow: (rows: unknown[]) => rows[0] ?? null,
  ilikeAny: vi.fn(),
  countRows: vi.fn(),
}));

vi.mock("@/server/email/dispatch", () => ({
  dispatchOutboundEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    SPECIALIST_REQUIRED: "claim.specialist_required",
    CONFIRMATION_REQUESTED: "claim.confirmation_requested",
    MISSING_INFO_REQUESTED: "claim.missing_info_requested",
    AGENT_DELIBERATED: "agent.deliberated",
    AGENT_NOTE: "agent.note",
    OUTBOUND_EMAIL_SENT: "email.outbound_sent",
    OUTBOUND_EMAIL_FAILED: "email.outbound_failed",
  },
}));

vi.mock("@/server/ai/deliberate", () => ({
  deliberate: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server/cases/gap-analyzer", () => ({
  MEDIUM_CONFIDENCE_HIGH: 0.85,
  analyzeEmailClaimGaps: vi.fn().mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  }),
}));

// Propio de este archivo: la escalación por severidad no lo necesita mockeado
// —el catch de `alertSpecialists` se traga cualquier TypeError del db mock
// genérico— pero acá es justamente lo que hay que comprobar que se llame.
vi.mock("@/server/notify/specialist-alert", () => ({
  alertSpecialists: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/lib/db";
import { dispatchOutboundEmail } from "@/server/email/dispatch";
import { writeAuditLog } from "@/lib/audit/log";
import { deliberate } from "@/server/ai/deliberate";
import { alertSpecialists } from "@/server/notify/specialist-alert";

// ── DB mock builder (idéntico al de orchestrate-post-extraction.test.ts) ──────

type MockDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const DRIZZLE_NAME = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  return (table as Record<symbol, string>)[DRIZZLE_NAME] ?? "";
}

function setupDbMocks() {
  const mockDbTyped = db as unknown as MockDb;

  const resultadoDeInsert: Record<string, unknown> = {};
  Object.assign(resultadoDeInsert, {
    then: (r: (v: unknown) => void, j?: (e: unknown) => void) =>
      Promise.resolve([]).then(r, j),
    onConflictDoUpdate: () => resultadoDeInsert,
    onConflictDoNothing: () => resultadoDeInsert,
    returning: () => Promise.resolve([]),
  });

  const insertSpy = vi.fn().mockReturnValue(resultadoDeInsert);
  const updateSpy = vi.fn().mockResolvedValue([]);

  mockDbTyped.select.mockImplementation(() => ({
    from: (table: unknown) => {
      const tableName = getTableName(table);

      if (tableName === "outbound_messages") {
        return {
          where: () => ({
            limit: () => Promise.resolve([]),
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
          }),
        };
      }

      const vacio = {
        limit: () => Promise.resolve([]),
        then: (r: (v: unknown) => void, j?: (e: unknown) => void) =>
          Promise.resolve([]).then(r, j),
      };
      return { where: () => vacio };
    },
  }));

  mockDbTyped.insert.mockImplementation(() => ({
    values: insertSpy,
  }));

  mockDbTyped.update.mockImplementation(() => ({
    set: (data: unknown) => ({
      where: () => updateSpy(data),
    }),
  }));

  return { insertSpy, updateSpy };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TENANT_ID = "cccccccc-0000-0000-0000-000000000002";
const SENDER_EMAIL = "claimant@example.com";
const NO_MATCHES: CustomerMatch[] = [];

const POLIZA_VENCIDA = {
  vigentes: 0,
  noVigentes: 1,
  vencioEl: "2020-03-01",
  derivar: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  setupDbMocks();
  vi.mocked(deliberate).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("una póliza vencida no es para pedir papeles", () => {
  it("deriva sin deliberar", async () => {
    const { updateSpy } = setupDbMocks();
    const claim = extractEmailClaimMock({ severity: "low" });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL, polizas: POLIZA_VENCIDA },
      NO_MATCHES
    );

    const statuses = updateSpy.mock.calls
      .map((c) => (c[0] as { status?: string }).status)
      .filter(Boolean);
    expect(statuses).toContain("requiere_especialista");

    // El plan se pide igual que en la escalación por severidad —branch B no
    // corta la función acá, lo hace más abajo cada `!derivaSola`— pero viaja
    // marcado para que `deliberate.ts` lo descarte sin consultar nada: por
    // eso `isHighSeverity: true` y no `expect(deliberate).not.toHaveBeenCalled()`.
    expect(deliberate).toHaveBeenCalledWith(
      expect.objectContaining({ isHighSeverity: true })
    );

    expect(alertSpecialists).toHaveBeenCalled();

    const entry = vi
      .mocked(writeAuditLog)
      .mock.calls.find((c) => c[0].event_type === "claim.specialist_required");
    expect(entry?.[0].payload).toMatchObject({
      reason: expect.stringContaining("póliza sin vigencia"),
    });
  });

  it("un solo mensaje, y no es un pedido de documentación", async () => {
    const claim = extractEmailClaimMock({ severity: "low" });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL, polizas: POLIZA_VENCIDA },
      NO_MATCHES
    );

    const templates = vi.mocked(dispatchOutboundEmail).mock.calls.map((c) => c[0].template);
    expect(templates).toEqual(["specialist_escalation"]);
    expect(templates).not.toContain("missing_information_request");
  });

  it("con la póliza vigente todo sigue igual", async () => {
    const { updateSpy } = setupDbMocks();
    const claim = extractEmailClaimMock({ severity: "low" });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    expect(deliberate).toHaveBeenCalled();

    const statuses = updateSpy.mock.calls
      .map((c) => (c[0] as { status?: string }).status)
      .filter(Boolean);
    expect(statuses).not.toContain("requiere_especialista");
  });

  /*
   * La frase de cuidado es de la derivación por gravedad. Por la póliza vencida
   * sola no se deriva por las heridas, y el mensaje no las nombra; con un caso
   * grave, sí, venza o no la póliza.
   */
  async function derivacionVencida(severity: "low" | "high") {
    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      {
        extractedClaim: extractEmailClaimMock({ severity, injury_severity: "severe" }),
        senderEmail: SENDER_EMAIL,
        polizas: POLIZA_VENCIDA,
      },
      NO_MATCHES
    );
    const salidas = vi.mocked(dispatchOutboundEmail).mock.calls;
    expect(salidas.map((c) => c[0].template)).toEqual(["specialist_escalation"]);
    return salidas[0][0].data as Record<string, unknown>;
  }

  it("con heridos y sin gravedad, la derivación de siempre", async () => {
    const data = await derivacionVencida("low");

    expect(data).not.toHaveProperty("heridos");
    expect(JSON.stringify(vi.mocked(alertSpecialists).mock.calls)).not.toContain("heridos");
  });

  it("con heridos y gravedad alta, abre con el cuidado", async () => {
    const data = await derivacionVencida("high");

    expect(data).toMatchObject({ heridos: true });
  });
});
