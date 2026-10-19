/**
 * El poller y la casilla vencida.
 *
 * Cuando Google contesta `invalid_grant` al leer la casilla de un inquilino, el
 * poller la marca vencida para que el panel pida reconectar. Sólo en las tres
 * ramas de error de la lectura, sólo con `invalid_grant` y sólo si la casilla
 * tiene refreshToken: la del entorno no tiene fila que marcar.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ingest: vi.fn(),
  despachar: vi.fn(),
  getGmailClient: vi.fn(),
  adaptar: vi.fn(),
  guardarAdjuntos: vi.fn(),
  marcar: vi.fn(),
  getOrCreatePollState: vi.fn(),
  recordPollError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/email/inbound-email", () => ({ ingestInboundEmail: m.ingest }));
vi.mock("@/server/worker/despachar-extraccion", () => ({ dispatchExtractionWorker: m.despachar }));
vi.mock("@/server/email/gmail/gmail-client", () => ({ getGmailClient: m.getGmailClient }));
vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountByEmail: vi.fn().mockResolvedValue(null),
  listEnabledGmailAccounts: vi.fn().mockResolvedValue([]),
  marcarCasillaVencida: m.marcar,
}));
vi.mock("@/server/email/gmail/poll-state", () => ({
  getOrCreatePollState: m.getOrCreatePollState,
  advancePollState: vi.fn().mockResolvedValue(undefined),
  recordPollError: m.recordPollError,
  guardarPendientes: vi.fn().mockResolvedValue(undefined),
  MAX_INTENTOS_POR_MENSAJE: 3,
}));
vi.mock("@/server/email/gmail/gmail-attachment-adapter", () => ({ adaptGmailAttachments: m.adaptar }));
vi.mock("@/server/email/rehost-attachments", () => ({ rehostAndRecordAttachments: m.guardarAdjuntos }));
vi.mock("@/server/email/dedupe", () => ({ checkDuplicate: vi.fn().mockResolvedValue(false) }));

import { pollGmail } from "@/server/email/gmail/gmail-poller";

const TENANT = "10000000-0000-0000-0000-000000000001";
const CASILLA = "casilla@example.com";
const CUENTA = { tenantId: TENANT, email: CASILLA, refreshToken: "fake-refresh-token" };

const permisoRevocado = () =>
  Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } });

function gmailQueFalla(err: Error) {
  return {
    users: {
      history: { list: vi.fn().mockRejectedValue(err) },
      messages: { list: vi.fn().mockRejectedValue(err), get: vi.fn(), modify: vi.fn() },
      getProfile: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GMAIL_USER_EMAIL = "claims@claimmix.com";
  delete process.env.GMAIL_TENANT_ID;
  m.getOrCreatePollState.mockResolvedValue({ id: "poll-state-uuid", historyId: "12345", pendientes: [] });
  m.recordPollError.mockResolvedValue(undefined);
  m.marcar.mockResolvedValue(undefined);
});

describe("pollGmail: casilla vencida", () => {
  it("history.list con invalid_grant marca la casilla vencida y sigue anotando el error", async () => {
    m.getGmailClient.mockReturnValue(gmailQueFalla(permisoRevocado()));

    const resultado = await pollGmail(CUENTA);

    expect(m.marcar).toHaveBeenCalledTimes(1);
    expect(m.marcar).toHaveBeenCalledWith(TENANT, CASILLA);
    expect(m.recordPollError).toHaveBeenCalledWith("poll-state-uuid", "history_list_failed: Error");
    expect(resultado.errors).toBe(1);
  });

  it("un 500 de Google no la marca: se arregla solo", async () => {
    m.getGmailClient.mockReturnValue(
      gmailQueFalla(Object.assign(new Error("backendError"), { code: 500 }))
    );

    const resultado = await pollGmail(CUENTA);

    expect(m.marcar).not.toHaveBeenCalled();
    expect(m.recordPollError).toHaveBeenCalledWith("poll-state-uuid", "history_list_failed: Error");
    expect(resultado.errors).toBe(1);
  });

  it("la casilla del entorno no tiene fila: invalid_grant no marca nada", async () => {
    m.getGmailClient.mockReturnValue(gmailQueFalla(permisoRevocado()));

    const resultado = await pollGmail();

    expect(m.marcar).not.toHaveBeenCalled();
    expect(resultado.errors).toBe(1);
  });

  it("la primera corrida (messages.list) con invalid_grant la marca", async () => {
    m.getOrCreatePollState.mockResolvedValue({ id: "poll-state-uuid", historyId: "1", pendientes: [] });
    m.getGmailClient.mockReturnValue(gmailQueFalla(permisoRevocado()));

    const resultado = await pollGmail(CUENTA);

    expect(m.marcar).toHaveBeenCalledTimes(1);
    expect(m.marcar).toHaveBeenCalledWith(TENANT, CASILLA);
    expect(m.recordPollError).toHaveBeenCalledWith("poll-state-uuid", "first_run_list_failed: Error");
    expect(resultado.errors).toBe(1);
  });

  it("el respaldo por historyNotFound con invalid_grant en messages.list también la marca", async () => {
    const gmail = gmailQueFalla(permisoRevocado());
    gmail.users.history.list.mockRejectedValue(Object.assign(new Error("historyNotFound"), { code: 404 }));
    m.getGmailClient.mockReturnValue(gmail);

    const resultado = await pollGmail(CUENTA);

    expect(m.marcar).toHaveBeenCalledWith(TENANT, CASILLA);
    expect(m.recordPollError).toHaveBeenCalledWith("poll-state-uuid", "messages_list_failed: Error");
    expect(resultado.errors).toBe(1);
  });

  it("si history.list contesta bien no marca nada", async () => {
    m.getGmailClient.mockReturnValue({
      users: {
        history: { list: vi.fn().mockResolvedValue({ data: { historyId: "99999", history: [] } }) },
        messages: { list: vi.fn(), get: vi.fn(), modify: vi.fn() },
        getProfile: vi.fn(),
      },
    });

    const resultado = await pollGmail(CUENTA);

    expect(m.marcar).not.toHaveBeenCalled();
    expect(m.recordPollError).not.toHaveBeenCalled();
    expect(resultado.errors).toBe(0);
  });
});
