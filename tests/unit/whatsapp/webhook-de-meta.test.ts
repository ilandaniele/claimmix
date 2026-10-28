/**
 * Lo que los dos webhooks de Meta (el de la plataforma y el de la app de cada cliente)
 * hacen igual con un lote ya firmado: guardar los mensajes y correr el agente.
 *
 * La firma y el ruteo no están acá: viven en cada ruta. Acá se prueba que sacar esto de la
 * ruta de la plataforma no cambió ninguna respuesta (los 38 casos de
 * tests/unit/server/api/webhooks-whatsapp-route.test.ts pasan sin tocarse).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedWhatsAppMessage } from "@/server/whatsapp/cloud-api";

const h = vi.hoisted(() => {
  const afterCallbacks: Array<() => unknown | Promise<unknown>> = [];
  return {
    afterCallbacks,
    mockAfter: vi.fn((cb: () => unknown | Promise<unknown>) => {
      afterCallbacks.push(cb);
    }),
    crear: vi.fn(),
    correr: vi.fn(),
    barrer: vi.fn(),
    retomar: vi.fn(),
    marcar: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: h.mockAfter }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: h.info, warn: h.warn, error: h.error, debug: vi.fn() } }));
vi.mock("@/server/agents/intake-agent", () => ({ createWhatsAppIntake: h.crear, runIntakeAgent: h.correr }));
vi.mock("@/server/intake/reap-stuck", () => ({ reapStuckProcessingCases: h.barrer }));
vi.mock("@/server/intake/retomar-pendientes", () => ({
  retomarExtraccionesPendientes: h.retomar,
  marcarPendientes: h.marcar,
  MINIMO_PARA_RETOMAR_MS: 120_000,
}));

import { atenderLoteDeMeta, ingest, scheduleAgent } from "@/server/whatsapp/webhook-de-meta";

const TENANT = "10000000-0000-4000-8000-000000000001";
const OTRO_TENANT = "10000000-0000-4000-8000-000000000002";
const NUMERO = "111111111111111";
const OTRO_NUMERO = "222222222222222";

const msg = (cambios: Partial<NormalizedWhatsAppMessage> = {}): NormalizedWhatsAppMessage => ({
  from: "5492916426930",
  body: "Tuve un choque",
  providerMessageId: "wamid.1",
  name: "Ilan",
  toPhoneNumberId: NUMERO,
  ...cambios,
});

const guardado = (cambios: Record<string, unknown> = {}) => ({
  caseId: "caso-1",
  tenantId: TENANT,
  created: true,
  duplicado: false,
  excedente: false,
  ...cambios,
});

const dePrueba = (n: string) => (n === NUMERO ? { tenantId: TENANT, wabaPropia: false } : undefined);
const lejos = () => Date.now() + 300_000;
const correrAfter = () => Promise.all(h.afterCallbacks.splice(0).map((cb) => cb()));

beforeEach(() => {
  h.afterCallbacks.length = 0;
  h.crear.mockResolvedValue(guardado());
  h.correr.mockResolvedValue(undefined);
  h.barrer.mockResolvedValue({ reaped: 0, caseIds: [] });
  h.retomar.mockResolvedValue({ retomados: 0, caseIds: [] });
  h.marcar.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ingest", () => {
  it("manda al intake el hilo por remitente y el nombre del sobre", async () => {
    await ingest(TENANT, msg({ media: [{ id: "media-1", mimeType: "image/jpeg" }] as never }));

    expect(h.crear).toHaveBeenCalledWith({
      tenantId: TENANT,
      wabaPropia: false,
      from: "5492916426930",
      body: "Tuve un choque",
      providerMessageId: "wamid.1",
      threadId: "5492916426930",
      media: [{ id: "media-1", mimeType: "image/jpeg" }],
      senderName: "Ilan",
    });
  });

  it("sin nombre en el sobre manda null, no undefined", async () => {
    await ingest(TENANT, msg({ name: undefined }));

    expect(h.crear).toHaveBeenCalledWith(expect.objectContaining({ senderName: null }));
  });

  it("por omisión no es WABA propia; si se lo dicen, lo manda al intake", async () => {
    await ingest(TENANT, msg());
    await ingest(TENANT, msg(), true);

    expect(h.crear).toHaveBeenNthCalledWith(1, expect.objectContaining({ wabaPropia: false }));
    expect(h.crear).toHaveBeenNthCalledWith(2, expect.objectContaining({ wabaPropia: true }));
  });
});

describe("atenderLoteDeMeta", () => {
  it("un lote vacío (estados de entrega, lecturas) es un 200 sin tocar nada", async () => {
    const r = await atenderLoteDeMeta([], dePrueba, lejos());

    expect(r).toEqual({ status: 200, cuerpo: { ok: true, received: 0, case_ids: [] } });
    expect(h.crear).not.toHaveBeenCalled();
    expect(h.mockAfter).not.toHaveBeenCalled();
  });

  it("guarda el mensaje, programa el agente y contesta con el caso", async () => {
    const r = await atenderLoteDeMeta([msg()], dePrueba, lejos());

    expect(r).toEqual({ status: 200, cuerpo: { ok: true, received: 1, case_ids: ["caso-1"] } });
    expect(h.crear).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, providerMessageId: "wamid.1" }));
    expect(h.mockAfter).toHaveBeenCalledTimes(1);
  });

  it("un número de WABA propia llega marcado al intake", async () => {
    const propia = (n: string) => (n === NUMERO ? { tenantId: TENANT, wabaPropia: true } : undefined);

    await atenderLoteDeMeta([msg()], propia, lejos());

    expect(h.crear).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, wabaPropia: true }));
  });

  it("el agente corre después de contestar, con el caso, el inquilino y el reloj de la invocación", async () => {
    const hasta = lejos();
    await atenderLoteDeMeta([msg()], dePrueba, hasta);
    expect(h.correr).not.toHaveBeenCalled();

    await correrAfter();

    expect(h.correr).toHaveBeenCalledWith({ caseId: "caso-1", tenantId: TENANT, source: "whatsapp", hasta });
    expect(h.barrer).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(h.retomar).toHaveBeenCalledWith({ tenantId: TENANT, limit: 2, hasta });
  });

  it("dos mensajes del mismo remitente en un pedido caen en un caso y corren un solo agente", async () => {
    await atenderLoteDeMeta([msg(), msg({ providerMessageId: "wamid.2" })], dePrueba, lejos());
    await correrAfter();

    expect(h.crear).toHaveBeenCalledTimes(2);
    expect(h.correr).toHaveBeenCalledTimes(1);
  });

  it("una reentrega (duplicado) se cuenta pero no vuelve a correr el agente", async () => {
    h.crear.mockResolvedValue(guardado({ duplicado: true }));

    const r = await atenderLoteDeMeta([msg()], dePrueba, lejos());

    expect(r.cuerpo).toMatchObject({ received: 1, case_ids: ["caso-1"] });
    expect(h.mockAfter).not.toHaveBeenCalled();
  });

  it("el que pasó el tope por remitente (excedente) se guarda y no corre el agente", async () => {
    h.crear.mockResolvedValue(guardado({ excedente: true }));

    const r = await atenderLoteDeMeta([msg()], dePrueba, lejos());

    expect(r.status).toBe(200);
    expect(h.mockAfter).not.toHaveBeenCalled();
  });

  it("un número que no es de nadie se descarta, se anota y se cuenta, sin reintento", async () => {
    const r = await atenderLoteDeMeta([msg({ toPhoneNumberId: OTRO_NUMERO })], dePrueba, lejos());

    expect(r).toEqual({ status: 200, cuerpo: { ok: true, received: 0, case_ids: [], ignored_other_number: 1 } });
    expect(h.crear).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith({ to_phone_number_id: OTRO_NUMERO }, "whatsapp.webhook.numero_desconocido");
  });

  it("un mensaje sin metadata del número también se descarta", async () => {
    const r = await atenderLoteDeMeta([msg({ toPhoneNumberId: undefined })], dePrueba, lejos());

    expect(r.cuerpo).toMatchObject({ ignored_other_number: 1 });
    expect(h.crear).not.toHaveBeenCalled();
  });

  it("el id del número se recorta antes de buscarlo", async () => {
    const r = await atenderLoteDeMeta([msg({ toPhoneNumberId: ` ${NUMERO} ` })], dePrueba, lejos());

    expect(r.cuerpo).toMatchObject({ received: 1 });
  });

  it("si un mensaje no se guarda, devuelve 500 para que Meta reentregue, y los demás igual corren", async () => {
    h.crear.mockRejectedValueOnce(new Error("23503 fallo")).mockResolvedValueOnce(guardado({ caseId: "caso-2" }));

    const r = await atenderLoteDeMeta([msg(), msg({ providerMessageId: "wamid.2", from: "5491100000000" })], dePrueba, lejos());

    expect(r.status).toBe(500);
    expect(r.cuerpo).toEqual({ error: { code: "INTAKE_FAILED", message: "Some messages could not be stored." } });
    expect(h.error).toHaveBeenCalledWith(
      { provider_message_id: "wamid.1", error: "23503 fallo" },
      "whatsapp.webhook.intake_failed"
    );
    await correrAfter();
    expect(h.correr).toHaveBeenCalledWith(expect.objectContaining({ caseId: "caso-2" }));
  });

  it("no anota el teléfono de la persona al fallar", async () => {
    h.crear.mockRejectedValue(new Error("boom"));

    await atenderLoteDeMeta([msg()], dePrueba, lejos());

    expect(JSON.stringify(h.error.mock.calls)).not.toContain("5492916426930");
  });

  it("un pedido con mensajes de dos inquilinos programa un agente por cada uno", async () => {
    h.crear
      .mockResolvedValueOnce(guardado())
      .mockResolvedValueOnce(guardado({ caseId: "caso-2", tenantId: OTRO_TENANT }));
    const destinoDe = (n: string) =>
      n === NUMERO
        ? { tenantId: TENANT, wabaPropia: false }
        : n === OTRO_NUMERO
          ? { tenantId: OTRO_TENANT, wabaPropia: true }
          : undefined;

    await atenderLoteDeMeta([msg(), msg({ toPhoneNumberId: OTRO_NUMERO, providerMessageId: "wamid.2" })], destinoDe, lejos());
    await correrAfter();

    expect(h.crear).toHaveBeenNthCalledWith(1, expect.objectContaining({ tenantId: TENANT, wabaPropia: false }));
    expect(h.crear).toHaveBeenNthCalledWith(2, expect.objectContaining({ tenantId: OTRO_TENANT, wabaPropia: true }));

    expect(h.mockAfter).toHaveBeenCalledTimes(2);
    expect(h.correr).toHaveBeenCalledWith(expect.objectContaining({ caseId: "caso-1", tenantId: TENANT }));
    expect(h.correr).toHaveBeenCalledWith(expect.objectContaining({ caseId: "caso-2", tenantId: OTRO_TENANT }));
  });
});

describe("scheduleAgent", () => {
  it("sin casos no programa nada", () => {
    scheduleAgent([], TENANT, true, lejos());

    expect(h.mockAfter).not.toHaveBeenCalled();
  });

  it("marca como pendientes todos menos el primero antes de empezar", async () => {
    scheduleAgent(["a", "b", "c"], TENANT, true, lejos());
    await correrAfter();

    expect(h.marcar).toHaveBeenCalledWith(["b", "c"], TENANT);
    expect(h.correr).toHaveBeenCalledTimes(3);
  });

  it("deja de arrancar casos cuando ya no entran en el reloj, y lo anota", async () => {
    scheduleAgent(["a", "b"], TENANT, true, Date.now() + 1_000);
    await correrAfter();

    expect(h.correr).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ quedaron: 1 }, "webhooks_whatsapp.sin_tiempo");
  });

  it("el fallo de un agente se anota y no frena a los demás", async () => {
    h.correr.mockRejectedValueOnce(new TypeError("boom"));
    scheduleAgent(["a", "b"], TENANT, true, lejos());
    await correrAfter();

    expect(h.error).toHaveBeenCalledWith({ error_name: "TypeError", case_id: "a" }, "webhooks_whatsapp.agent_error");
    expect(h.correr).toHaveBeenCalledTimes(2);
  });

  it("el tráfico simulado no barre ni retoma", async () => {
    scheduleAgent(["a"], TENANT, false, lejos());
    await correrAfter();

    expect(h.correr).toHaveBeenCalledTimes(1);
    expect(h.barrer).not.toHaveBeenCalled();
    expect(h.retomar).not.toHaveBeenCalled();
  });

  it("el barrido y el retomo que fallan se anotan y no tiran", async () => {
    h.barrer.mockRejectedValue(new Error("x"));
    h.retomar.mockRejectedValue(new RangeError("y"));
    scheduleAgent(["a"], TENANT, true, lejos());

    await expect(correrAfter()).resolves.toBeDefined();
    expect(h.error).toHaveBeenCalledWith({ error_name: "Error" }, "webhooks_whatsapp.barrido_error");
    expect(h.error).toHaveBeenCalledWith({ error_name: "RangeError" }, "webhooks_whatsapp.retomar_pendientes_error");
  });
});
