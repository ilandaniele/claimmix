/**
 * Responder un caso por WhatsApp desde el caso, sin pasar por el agente.
 *
 * `estadoDeRespuesta` y `isReservedTestNumber` van sin mockear: son puros y lo
 * que importa acá es que esta función los obedezca — que nunca mande ni
 * inserte cuando el estado no habilita, y que nunca le escriba a un número
 * reservado o a un caso simulado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnTenant, mockEnTenantVarias, mockSend, mockWriteAuditLog, mockCredenciales, mockSinNumero } =
  vi.hoisted(() => ({
    mockEnTenant: vi.fn(),
    mockEnTenantVarias: vi.fn(),
    mockSend: vi.fn(),
    mockWriteAuditLog: vi.fn(),
    mockCredenciales: vi.fn(),
    mockSinNumero: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({
  enTenant: mockEnTenant,
  enTenantVarias: mockEnTenantVarias,
}));
vi.mock("@/server/whatsapp/cloud-api", () => ({ sendWhatsAppText: mockSend }));
vi.mock("@/server/whatsapp/numeros", () => ({
  credencialesWhatsApp: mockCredenciales,
  avisarSinNumero: mockSinNumero,
}));
vi.mock("@/lib/audit/log", () => ({
  AuditEvent: { CASE_HUMAN_REPLY: "case.human_reply" },
  writeAuditLog: mockWriteAuditLog,
}));

import { responderPorWhatsApp, PLANTILLA_RESPUESTA_HUMANA } from "@/server/confirmations/respuesta-humana";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const OTRO_USUARIO_ID = "20000000-0000-0000-0000-000000000002";
const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TEXTO = "Ya está resuelto, gracias por avisar.";
const CRED = { accessToken: "test-token", phoneNumberId: "123456", wabaId: "654321", autoalta: false, vencida: false };

const CTX = {
  user: { id: USER_ID },
  userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst", plan: "profesional" },
};

const HACE_UN_MINUTO = () => new Date(Date.now() - 60_000).toISOString();
const HACE_VEINTICINCO_HORAS = () => new Date(Date.now() - 25 * 60 * 60_000).toISOString();

/** El primer viaje: el caso y el último entrante de WhatsApp, en un lote. */
function caso(
  o: Partial<{
    status: string;
    channel: string;
    email_thread_id: string | null;
    assigned_to: string | null;
  }> = {}
) {
  return [
    [
      {
        id: CASE_ID,
        status: o.status ?? "listo",
        channel: o.channel ?? "whatsapp",
        email_thread_id: o.email_thread_id ?? "5491100000001",
        assigned_to: o.assigned_to ?? null,
      },
    ],
    [{ received_at: HACE_UN_MINUTO() }],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ ok: true, messageId: "wamid.1" });
  mockCredenciales.mockResolvedValue(CRED);
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

  it("un analista en un caso asignado a otro: no_encontrado, no manda ni inserta ni audita", async () => {
    mockEnTenantVarias.mockResolvedValueOnce(caso({ assigned_to: OTRO_USUARIO_ID }));

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "no_encontrado" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEnTenant).not.toHaveBeenCalled();
    expect(mockEnTenantVarias).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("el no_encontrado de un caso ajeno no depende del resto del estado", async () => {
    mockEnTenantVarias.mockResolvedValueOnce(caso({ status: "recibido", assigned_to: OTRO_USUARIO_ID }));

    expect(await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO)).toEqual({
      ok: false,
      motivo: "no_encontrado",
    });
  });

  it.each([
    ["un analista, en un caso suyo", "analyst", USER_ID],
    ["un analista, en un caso sin asignar", "analyst", null],
    ["un admin, en un caso asignado a otro", "admin", OTRO_USUARIO_ID],
  ])("%s, manda", async (_quien, role, assigned_to) => {
    mockEnTenantVarias
      .mockResolvedValueOnce(caso({ assigned_to }))
      .mockResolvedValueOnce([undefined, undefined]);
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-1" }]);
    const ctx = { ...CTX, userRow: { ...CTX.userRow, role } };

    const r = await responderPorWhatsApp(ctx as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: true, id: "outbound-1", estado: "sent" });
    expect(mockSend).toHaveBeenCalledTimes(1);
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
      [
        {
          id: CASE_ID,
          status: "listo",
          channel: "whatsapp",
          email_thread_id: "5491100000001",
          assigned_to: null,
        },
      ],
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
      .mockResolvedValueOnce([undefined, undefined]);
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-1" }]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(mockSend).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, id: "outbound-1", estado: "skipped_simulated" });
  });

  it("canal whatsapp_sim, no llama a Meta y queda simulado aunque el número parezca real", async () => {
    mockEnTenantVarias
      .mockResolvedValueOnce(caso({ channel: "whatsapp_sim" }))
      .mockResolvedValueOnce([undefined, undefined]);
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-1" }]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(mockSend).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, id: "outbound-1", estado: "skipped_simulated" });
  });

  it("J: inserta la fila 'queued' antes de mandar por Meta, no después", async () => {
    mockEnTenantVarias
      .mockResolvedValueOnce(caso())
      .mockResolvedValueOnce([undefined, undefined]);
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-1" }]);

    await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    const ordenInsert = mockEnTenant.mock.invocationCallOrder[0]!;
    const ordenEnvio = mockSend.mock.invocationCallOrder[0]!;
    expect(ordenInsert).toBeLessThan(ordenEnvio);

    // El insert es "queued", no un estado final: el envío todavía no pasó.
    const armarInsert = mockEnTenant.mock.calls[0]![1] as (db: unknown) => unknown;
    let statusInsertado: unknown;
    armarInsert({
      insert: () => ({
        values: (v: { status: unknown }) => {
          statusInsertado = v.status;
          return { returning: () => "insert" };
        },
      }),
    });
    expect(statusInsertado).toBe("queued");
  });

  it("dentro de la ventana, manda por Meta, inserta el saliente, saca «para responder» y audita con ip/ua", async () => {
    mockEnTenantVarias
      .mockResolvedValueOnce(caso())
      .mockResolvedValueOnce([undefined, undefined]);
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-1" }]);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO, { ip: "1.2.3.4", ua: "curl/8" });

    expect(mockCredenciales).toHaveBeenCalledWith(TENANT_ID);
    expect(mockSend).toHaveBeenCalledWith("5491100000001", TEXTO, CRED);
    expect(r).toEqual({ ok: true, id: "outbound-1", estado: "sent" });
    // Un insert propio (queued) y, después de mandar, un lote con el update y
    // la marca de «para responder» — nunca junto al insert.
    expect(mockEnTenant).toHaveBeenCalledTimes(1);
    expect(mockEnTenantVarias).toHaveBeenCalledTimes(2);

    // El segundo viaje actualiza el estado y saca la marca en el mismo lote.
    const armar = mockEnTenantVarias.mock.calls[1]![1] as (db: unknown) => unknown[];
    const consultas = armar({
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
        ip: "1.2.3.4",
        ua: "curl/8",
      })
    );
    // Nunca el texto de la respuesta en el registro.
    const payload = mockWriteAuditLog.mock.calls[0]![0].payload;
    expect(JSON.stringify(payload)).not.toContain(TEXTO);
  });

  it("R5: la credencial llega entera a Meta, con la prueba del secreto de la app propia si la tiene", async () => {
    const propia = { ...CRED, propia: true, prueba: "fake-proof-0123" };
    mockCredenciales.mockResolvedValueOnce(propia);
    mockEnTenantVarias.mockResolvedValueOnce(caso()).mockResolvedValueOnce([undefined, undefined]);
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-1" }]);

    await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(mockSend.mock.calls[0]![2]).toBe(propia);
  });

  it("R5: con Embedded Signup no se inventa una prueba", async () => {
    mockEnTenantVarias.mockResolvedValueOnce(caso()).mockResolvedValueOnce([undefined, undefined]);
    mockEnTenant.mockResolvedValueOnce([{ id: "outbound-1" }]);

    await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(mockSend.mock.calls[0]![2]).not.toHaveProperty("prueba");
  });

  it("si Meta rechaza el envío, guarda la fila como failed, no saca la marca y avisa envio_fallido", async () => {
    mockSend.mockResolvedValueOnce({ ok: false, error: "meta_down" });
    mockEnTenantVarias.mockResolvedValueOnce(caso());
    mockEnTenant
      .mockResolvedValueOnce([{ id: "outbound-2" }])
      .mockResolvedValueOnce(undefined);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "envio_fallido" });
    // Insert y update por separado, nunca en lote con la marca de «para responder».
    expect(mockEnTenant).toHaveBeenCalledTimes(2);
    expect(mockEnTenantVarias).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { outbound_id: "outbound-2", estado: "failed" } })
    );
  });

  it("sin número conectado, no llama a Meta, lo anota y deja la fila como failed", async () => {
    mockCredenciales.mockResolvedValueOnce(null);
    mockEnTenantVarias.mockResolvedValueOnce(caso());
    mockEnTenant
      .mockResolvedValueOnce([{ id: "outbound-3" }])
      .mockResolvedValueOnce(undefined);

    const r = await responderPorWhatsApp(CTX as never, CASE_ID, TEXTO);

    expect(r).toEqual({ ok: false, motivo: "envio_fallido" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSinNumero).toHaveBeenCalledWith(TENANT_ID, "respuesta_humana");
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { outbound_id: "outbound-3", estado: "failed" } })
    );
  });

  it("la plantilla es siempre la misma, para que Meta la reconozca", () => {
    expect(PLANTILLA_RESPUESTA_HUMANA).toBe("wa_respuesta_humana");
  });
});
