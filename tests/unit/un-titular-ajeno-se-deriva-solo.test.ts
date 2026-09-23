/**
 * Quien escribe no es el titular: se deriva sola, sin esperar al modelo.
 *
 * El worker ya sabe que ni el nombre ni el DNI que dio la persona son los del
 * titular de la póliza (`esTitularAjeno`) y lo pasa en
 * `extractedOutput.titularAjeno`. El orquestador manda el pedido de
 * confirmación con los dos valores —el único mensaje de la vuelta— y deriva por
 * el MISMO `escalate()` que la severidad y la póliza vencida, sin deliberar.
 *
 * Mocks copiados de una-poliza-vencida-no-es-para-pedir-papeles.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";
import type { CustomerMatch } from "@/server/matching/customer-matcher";
import type { AgentMessenger } from "@/server/confirmations/messenger";

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

vi.mock("@/server/confirmations/ya-contestado", () => ({
  yaContestamosElUltimoMensaje: vi.fn().mockResolvedValue(false),
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

vi.mock("@/server/notify/specialist-alert", () => ({
  alertSpecialists: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/lib/db";
import { dispatchOutboundEmail } from "@/server/email/dispatch";
import { writeAuditLog } from "@/lib/audit/log";
import { deliberate } from "@/server/ai/deliberate";
import { alertSpecialists } from "@/server/notify/specialist-alert";
import { yaContestamosElUltimoMensaje } from "@/server/confirmations/ya-contestado";

// ── DB mock (el de una-poliza-vencida, más las tablas que se leen) ────────────

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
  const tablas: string[] = [];

  const resultadoDeInsert: Record<string, unknown> = {};
  Object.assign(resultadoDeInsert, {
    then: (r: (v: unknown) => void, j?: (e: unknown) => void) =>
      Promise.resolve([]).then(r, j),
    onConflictDoUpdate: () => resultadoDeInsert,
    onConflictDoNothing: () => resultadoDeInsert,
    returning: () => Promise.resolve([]),
  });

  const updateSpy = vi.fn().mockResolvedValue([]);

  mockDbTyped.select.mockImplementation(() => ({
    from: (table: unknown) => {
      const tableName = getTableName(table);
      tablas.push(tableName);

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
    values: vi.fn().mockReturnValue(resultadoDeInsert),
  }));

  mockDbTyped.update.mockImplementation(() => ({
    set: (data: unknown) => ({
      where: () => updateSpy(data),
    }),
  }));

  return { updateSpy, tablas };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TENANT_ID = "cccccccc-0000-0000-0000-000000000002";
const SENDER_EMAIL = "claimant@example.com";
const RAZON = "quien escribe no es el titular de la póliza";
const DATOS_DE_PERSONAS = ["Roberto", "Lucía", "26880140", "41.207.663", "41207663"];

const TITULAR: CustomerMatch = {
  customerId: "cust-003",
  matchType: "policy_number",
  confidence: 0.9,
  customerName: "Roberto Paz",
  conflictsWithExtracted: ["full_name", "dni"],
  storedValues: { full_name: "Roberto Paz", dni: "26880140" },
};

function claimDeUnFamiliar(severity: "low" | "critical" = "low") {
  return extractEmailClaimMock({
    severity,
    fields: [
      ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "full_name"),
      { field_key: "full_name", field_value: "Lucía Paz", confidence: 0.93, source: "ai" as const },
      { field_key: "dni", field_value: "41.207.663", confidence: 0.93, source: "ai" as const },
    ],
  });
}

const CANALES = [
  ["correo", false],
  ["WhatsApp", true],
] as const;

const mensajero = (porMensajero: boolean) =>
  porMensajero
    ? { send: vi.fn<AgentMessenger["send"]>().mockResolvedValue(undefined) }
    : undefined;

/** Lo que salió, por el canal que haya sido. */
function mensajes(messenger?: { send: ReturnType<typeof vi.fn> }) {
  const llamadas = messenger
    ? messenger.send.mock.calls
    : vi.mocked(dispatchOutboundEmail).mock.calls;
  return llamadas.map((c) => c[0] as { template: string; data: Record<string, unknown> });
}

const estados = (updateSpy: ReturnType<typeof vi.fn>) =>
  updateSpy.mock.calls
    .map((c) => (c[0] as { status?: string }).status)
    .filter(Boolean);

const eventos = (tipo: string) =>
  vi.mocked(writeAuditLog).mock.calls.filter((c) => c[0].event_type === tipo);

const previo = process.env.AGENT_COMPOSE_REPLIES;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_COMPOSE_REPLIES = "off";
  vi.mocked(deliberate).mockResolvedValue(null);
  vi.mocked(yaContestamosElUltimoMensaje).mockResolvedValue(false);
});

afterEach(() => {
  if (previo === undefined) delete process.env.AGENT_COMPOSE_REPLIES;
  else process.env.AGENT_COMPOSE_REPLIES = previo;
  vi.restoreAllMocks();
});

async function correr(
  extra: { titularAjeno?: boolean; heredadaEn?: string; polizas?: { vigentes: number; noVigentes: number; vencioEl: string | null; derivar: boolean } } = {},
  messenger?: AgentMessenger,
  claim = claimDeUnFamiliar()
) {
  await orchestratePostExtraction(
    CASE_ID,
    TENANT_ID,
    { extractedClaim: claim, senderEmail: SENDER_EMAIL, ...extra },
    [TITULAR],
    messenger
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("un titular ajeno se deriva solo", () => {
  it("deriva sin deliberar, después del pedido de confirmación", async () => {
    const { updateSpy } = setupDbMocks();

    await correr({ titularAjeno: true });

    const vistos = estados(updateSpy);
    expect(vistos.at(-1)).toBe("requiere_especialista");
    expect(vistos.indexOf("confirmacion_pendiente")).toBeGreaterThanOrEqual(0);
    expect(vistos.indexOf("confirmacion_pendiente")).toBeLessThan(
      vistos.indexOf("requiere_especialista")
    );

    expect(deliberate).not.toHaveBeenCalled();
    expect(alertSpecialists).toHaveBeenCalledTimes(1);

    const derivaciones = eventos("claim.specialist_required");
    expect(derivaciones).toHaveLength(1);
    expect(derivaciones[0][0].payload).toMatchObject({ reason: RAZON });

    // Ni nombres ni documentos en lo que queda escrito o le llega al especialista.
    const escrito = JSON.stringify([
      derivaciones[0][0].payload,
      vi.mocked(alertSpecialists).mock.calls[0][0],
    ]);
    for (const dato of DATOS_DE_PERSONAS) expect(escrito).not.toContain(dato);
  });

  it.each(CANALES)(
    "por %s: un solo mensaje, el pedido con los dos valores",
    async (_canal, porMensajero) => {
      const { updateSpy } = setupDbMocks();
      const messenger = mensajero(porMensajero);

      await correr({ titularAjeno: true }, messenger);

      const salieron = mensajes(messenger);
      expect(salieron.map((m) => m.template)).toEqual(["data_confirmation_request"]);
      expect(salieron[0].data.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ fieldKey: "full_name", conflictWithValue: "Roberto Paz" }),
          expect.objectContaining({ fieldKey: "dni", conflictWithValue: "26880140" }),
        ])
      );
      // El pedido sabe que la vuelta termina derivada: no pregunta cuál es el correcto.
      expect(salieron[0].data.titularAjeno).toBe(true);
      if (messenger) expect(dispatchOutboundEmail).not.toHaveBeenCalled();

      expect(eventos("claim.confirmation_requested")).toHaveLength(1);
      expect(estados(updateSpy).at(-1)).toBe("requiere_especialista");
    }
  );

  it("no vuelve a buscar al titular en el padrón", async () => {
    const { tablas } = setupDbMocks();

    await correr({ titularAjeno: true });

    expect(tablas).not.toContain("policies");
  });

  it("un caso grave ya derivado no se deriva dos veces", async () => {
    setupDbMocks();

    await correr({ titularAjeno: true }, undefined, claimDeUnFamiliar("critical"));

    expect(mensajes().map((m) => m.template)).toEqual(["specialist_escalation"]);
    expect(eventos("claim.specialist_required")).toHaveLength(1);
    expect(alertSpecialists).toHaveBeenCalledTimes(1);
  });

  it("una póliza vencida ya derivada tampoco", async () => {
    setupDbMocks();

    await correr({
      titularAjeno: true,
      polizas: { vigentes: 0, noVigentes: 1, vencioEl: "2020-03-01", derivar: true },
    });

    expect(eventos("claim.specialist_required")).toHaveLength(1);
    expect(alertSpecialists).toHaveBeenCalledTimes(1);
  });

  it("sin la señal del worker decide el modelo, como antes", async () => {
    const { updateSpy } = setupDbMocks();

    await correr();

    expect(deliberate).toHaveBeenCalled();
    expect(estados(updateSpy)).not.toContain("requiere_especialista");
    expect(mensajes().map((m) => m.template)).toEqual(["data_confirmation_request"]);
    expect(mensajes()[0].data.titularAjeno).toBe(false);
  });

  it("una corrida heredada que ya contestó no escribe, pero deriva igual", async () => {
    const { updateSpy } = setupDbMocks();
    vi.mocked(yaContestamosElUltimoMensaje).mockResolvedValue(true);

    await correr({ titularAjeno: true, heredadaEn: "2026-09-23T10:00:00.000Z" });

    expect(dispatchOutboundEmail).not.toHaveBeenCalled();
    expect(estados(updateSpy).at(-1)).toBe("requiere_especialista");
    expect(eventos("claim.specialist_required")).toHaveLength(1);
    expect(alertSpecialists).toHaveBeenCalledTimes(1);
  });
});
