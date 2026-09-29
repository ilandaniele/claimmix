/**
 * Un correo que cae en un caso que ya existía: el ingreso lo marca en «Para
 * responder» si el agente ya terminó. El disparador es que una persona
 * escribió, no que algo despachó una extracción.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockThreadLookup, mockReabrir, mockMarcar, mockInsert, mockEnTenantVarias, mockLoggerWarn, mockLoggerError } =
  vi.hoisted(() => ({
    mockThreadLookup: vi.fn(),
    mockReabrir: vi.fn(),
    mockMarcar: vi.fn(),
    mockInsert: vi.fn(),
    mockEnTenantVarias: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/data/scope", async () => ({
  enTenant: (await import("../../../mocks/puente-de-alcance")).puenteDeAlcance(() => ({ insert: mockInsert }))
    .enTenant,
  enTenantVarias: mockEnTenantVarias,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: mockLoggerWarn, error: mockLoggerError, info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/server/email/thread-lookup", () => ({ threadLookup: mockThreadLookup }));
vi.mock("@/server/email/relevance-prefilter", async (original) => ({
  ...(await original<typeof import("@/server/email/relevance-prefilter")>()),
  classifyInboundEmailForIntake: () => ({ action: "allow" }),
}));
vi.mock("@/server/cases/reabrir-no-relevante", () => ({ reabrirSiEraNoRelevante: mockReabrir }));
vi.mock("@/server/cases/para-responder", () => ({ marcarParaResponder: mockMarcar }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: { EMAIL_RECEIVED: "email.received", EMAIL_FILTERED: "email.filtered" },
}));

import { ingestInboundEmail } from "@/server/email/inbound-email";

const TENANT = "10000000-0000-0000-0000-000000000001";
const CORREO = {
  tenantId: TENANT,
  channel: "email_sim" as const,
  fromAddr: "persona@example.com",
  subject: "Re: mi siniestro",
  bodyText: "Les mando lo que faltaba.",
  messageId: "<m2@example.com>",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockImplementation(() => ({
    values: () => ({ returning: () => Promise.resolve([{ id: "fila-1" }]) }),
  }));
  mockReabrir.mockResolvedValue("listo");
  mockMarcar.mockResolvedValue(undefined);
});

describe("ingestInboundEmail — «Para responder»", () => {
  it("una respuesta en el hilo de un caso marca ese caso, después de guardar el mensaje", async () => {
    mockThreadLookup.mockResolvedValue({ existingCaseId: "caso-viejo" });

    await ingestInboundEmail(CORREO);

    expect(mockMarcar).toHaveBeenCalledWith("caso-viejo", TENANT);
    expect(mockInsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockMarcar.mock.invocationCallOrder[0]
    );
  });

  // Lo que leyó `reabrirSiEraNoRelevante` alcanza: sin otro UPDATE a ciegas.
  it("si la conversación sigue con el agente, ni la marca ni su UPDATE", async () => {
    mockThreadLookup.mockResolvedValue({ existingCaseId: "caso-viejo" });
    mockReabrir.mockResolvedValue("info_faltante");

    await ingestInboundEmail(CORREO);

    expect(mockMarcar).not.toHaveBeenCalled();
  });

  // Si lo cerró el silencio o una persona lo decide la base, no el ingreso.
  it("una respuesta a un caso cerrado intenta marcarlo", async () => {
    mockThreadLookup.mockResolvedValue({ existingCaseId: "caso-viejo" });
    mockReabrir.mockResolvedValue("cerrado");

    await ingestInboundEmail(CORREO);

    expect(mockMarcar).toHaveBeenCalledWith("caso-viejo", TENANT);
  });

  it("una respuesta automática en el hilo no marca el caso", async () => {
    mockThreadLookup.mockResolvedValue({ existingCaseId: "caso-viejo" });

    for (const headers of [
      [{ name: "Auto-Submitted", value: "auto-replied" }],
      [{ name: "Precedence", value: "bulk" }],
      [{ name: "List-Unsubscribe", value: "<mailto:baja@example.com>" }],
    ]) {
      await ingestInboundEmail({ ...CORREO, headers });
    }

    expect(mockMarcar).not.toHaveBeenCalled();
  });

  // El reintento del poller lo saltearía por duplicado: tirar no recupera nada.
  it("si marcar falla, el correo igual queda procesado", async () => {
    mockThreadLookup.mockResolvedValue({ existingCaseId: "caso-viejo" });
    mockMarcar.mockRejectedValue(new Error("neon"));

    await expect(ingestInboundEmail(CORREO)).resolves.toMatchObject({ outcome: "processed" });
  });

  it("un correo que abre un caso nuevo no marca nada: lo contesta el agente", async () => {
    mockThreadLookup.mockResolvedValue({ existingCaseId: null });

    await ingestInboundEmail(CORREO);

    expect(mockMarcar).not.toHaveBeenCalled();
  });
});

// Un run anterior puede haber creado el caso y fallado antes de guardar el
// mensaje. El 23505 de hoy trataba eso como duplicado y perdía el correo para
// siempre en el reintento.
describe("ingestInboundEmail — alta parcial recuperada (23505)", () => {
  const violacionUnica = () =>
    Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));

  beforeEach(() => {
    mockThreadLookup.mockResolvedValue({ existingCaseId: null });
    mockInsert.mockImplementationOnce(() => ({
      values: () => ({ returning: violacionUnica }),
    }));
  });

  it("con el caso pero sin su mensaje, sigue el alta con ese caso", async () => {
    mockEnTenantVarias.mockResolvedValue([[{ id: "caso-recuperado" }], []]);

    const result = await ingestInboundEmail(CORREO);

    expect(result).toMatchObject({
      outcome: "processed",
      caseId: "caso-recuperado",
      isNewCase: true,
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { case_id: "caso-recuperado" },
      "inbound_email.case_insert_recovered"
    );
  });

  it("si el mensaje ya se había guardado, sigue siendo un duplicado", async () => {
    mockEnTenantVarias.mockResolvedValue([[{ id: "caso-recuperado" }], [{ id: "mensaje-viejo" }]]);

    await expect(ingestInboundEmail(CORREO)).resolves.toEqual({
      outcome: "skipped",
      reason: "duplicate",
    });
  });

  it("si no hay caso con ese email_message_id, sigue siendo un duplicado", async () => {
    mockEnTenantVarias.mockResolvedValue([[], []]);

    await expect(ingestInboundEmail(CORREO)).resolves.toEqual({
      outcome: "skipped",
      reason: "duplicate",
    });
  });

  it("si la búsqueda de recuperación falla, no se rompe: sigue siendo un duplicado", async () => {
    mockEnTenantVarias.mockRejectedValue(Object.assign(new Error("neon"), { code: "ECONNRESET" }));

    await expect(ingestInboundEmail(CORREO)).resolves.toEqual({
      outcome: "skipped",
      reason: "duplicate",
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      { code: "ECONNRESET" },
      "inbound_email.case_insert_recovery_failed"
    );
  });
});
