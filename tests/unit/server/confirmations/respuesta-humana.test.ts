/**
 * Responder un caso por WhatsApp desde el caso, sin pasar por el agente.
 *
 * `estadoDeRespuesta` y `isReservedTestNumber` van sin mockear: son puros y lo
 * que importa acá es que esta función los obedezca — que nunca mande ni
 * inserte cuando el estado no habilita, y que nunca le escriba a un número
 * reservado o a un caso simulado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnTenant, mockEnTenantVarias, mockSend, mockWriteAuditLog } = vi.hoisted(() => ({
  mockEnTenant: vi.fn(),
  mockEnTenantVarias: vi.fn(),
  mockSend: vi.fn(),
  mockWriteAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({
  enTenant: mockEnTenant,
  enTenantVarias: mockEnTenantVarias,
}));
vi.mock("@/server/whatsapp/cloud-api", () => ({ sendWhatsAppText: mockSend }));
vi.mock("@/lib/audit/log", () => ({
  AuditEvent: { CASE_HUMAN_REPLY: "case.human_reply" },
  writeAuditLog: mockWriteAuditLog,
}));

import { responderPorWhatsApp, PLANTILLA_RESPUESTA_HUMANA } from "@/server/confirmations/respuesta-humana";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TEXTO = "Ya está resuelto, gracias por avisar.";

const CTX = {
  user: { id: USER_ID },
  userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst", plan: "profesional" },
};

const HACE_UN_MINUTO = () => new Date(Date.now() - 60_000).toISOString();
const HACE_VEINTICINCO_HORAS = () => new Date(Date.now() - 25 * 60 * 60_000).toISOString();

/** El primer viaje: el caso y el último entrante de WhatsApp, en un lote. */
function caso(o: Partial<{ status: string; channel: string; email_thread_id: string | null }> = {}) {
  return [
    [
      {
        id: CASE_ID,
        status: o.status ?? "listo",
        channel: o.channel ?? "whatsapp",
        email_thread_id: o.email_thread_id ?? "5491100000001",
      },
    ],
    [{ received_at: HACE_UN_MINUTO() }],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ ok: true, messageId: "wamid.1" });
  mockWriteAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("responderPorWhatsApp", () => {
  it("caso inexistente: no manda ni inserta", async () => {
    mockEnTenantVarias.mockResolvedValueOnce([[], []]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "no_encontrado" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEnTenant).not.toHaveBeenCalled();
    expect(mockEnTenantVarias).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("con el agente activo, no manda ni inserta", async () => {
    mockEnTenantVarias.mockResolvedValueOnce(caso({ status: "recibido" }));

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "agente_activo" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEnTenant).not.toHaveBeenCalled();
    expect(mockEnTenantVarias).toHaveBeenCalledTimes(1);
  });

  it("fuera de la ventana de 24 h, no manda ni inserta", async () => {
    mockEnTenantVarias.mockResolvedValueOnce([
      [{ id: CASE_ID, status: "listo", channel: "whatsapp", email_thread_id: "5491100000001" }],
      [{ received_at: HACE_VEINTICINCO_HORAS() }],
    ]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "ventana" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("sin Plan Pro, no manda ni inserta", async () => {
    mockEnTenantVarias.mockResolvedValueOnce(caso());
    const ctxSinPro = { ...CTX, userRow: { ...CTX.userRow, plan: "piloto" } };

    const r = await responderPorWhatsApp(ctxSinPro as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "plan" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a un número reservado para pruebas, no llama a Meta y queda simulado", async () => {
    mockEnTenantVarias
      .mockResolvedValueOnce(caso({ email_thread_id: "5490000123456" }))
      .mockResolvedValueOnce([[{ id: "outbound-1" }], undefined]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(mockSend).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, id: "outbound-1", estado: "skipped_simulated" });
  });

  it("canal whatsapp_sim, no llama a Meta y queda simulado aunque el número parezca real", async () => {
    mockEnTenantVarias
      .mockResolvedValueOnce(caso({ channel: "whatsapp_sim" }))
      .mockResolvedValueOnce([[{ id: "outbound-1" }], undefined]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(mockSend).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, id: "outbound-1", estado: "skipped_simulated" });
  });

  it("dentro de la ventana, manda por Meta, inserta el saliente, saca «para responder» y audita", async () => {
    mockEnTenantVarias
      .mockResolvedValueOnce(caso())
      .mockResolvedValueOnce([[{ id: "outbound-1" }], undefined]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(mockSend).toHaveBeenCalledWith("5491100000001", TEXTO);
    expect(r).toEqual({ ok: true, id: "outbound-1", estado: "sent" });
    expect(mockEnTenantVarias).toHaveBeenCalledTimes(2);
    expect(mockEnTenant).not.toHaveBeenCalled();

    // El segundo viaje inserta y saca la marca en el mismo lote.
    const armar = mockEnTenantVarias.mock.calls[1]![1] as (db: unknown) => unknown[];
    const consultas = armar({
      insert: () => ({ values: () => ({ returning: () => "insert" }) }),
      update: () => ({ set: () => ({ where: () => "update" }) }),
    });
    expect(consultas).toHaveLength(2);

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: USER_ID,
        event_type: "case.human_reply",
        target_type: "case",
        target_id: CASE_ID,
        payload: { outbound_id: "outbound-1", estado: "sent" },
      })
    );
    // Nunca el texto de la respuesta en el registro.
    const payload = mockWriteAuditLog.mock.calls[0]![0].payload;
    expect(JSON.stringify(payload)).not.toContain(TEXTO);
  });

  it("si Meta rechaza el envío, guarda la fila como failed, no saca la marca y avisa envio_fallido", async () => {
    mockSend.mockResolvedValueOnce({ ok: false, error: "meta_down" });
    mockEnTenantVarias.mockResolvedValueOnce(caso());
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-2" }]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "envio_fallido" });
    // Un solo insert, sin lote junto a un update: la marca sigue puesta.
    expect(mockEnTenant).toHaveBeenCalledTimes(1);
    expect(mockEnTenantVarias).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { outbound_id: "outbound-2", estado: "failed" } })
    );
  });

  it("la plantilla es siempre la misma, para que Meta la reconozca", () => {
    expect(PLANTILLA_RESPUESTA_HUMANA).toBe("wa_respuesta_humana");
  });
});
