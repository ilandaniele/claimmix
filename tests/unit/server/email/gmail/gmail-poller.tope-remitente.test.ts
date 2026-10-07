/**
 * El poller y el tope por remitente (E12).
 *
 * Pasado el tope, `ingestInboundEmail` guarda el mail y lo marca «Para
 * responder» y lo dice con `excedente`. El poller no despacha la extracción
 * —ése es el gasto que el tope evita—, pero sí baja los adjuntos: el mail se
 * marca leído y no vuelve, y quien lo conteste los necesita.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ingest: vi.fn(),
  despachar: vi.fn(),
  getGmailClient: vi.fn(),
  adaptar: vi.fn(),
  guardarAdjuntos: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/email/inbound-email", () => ({ ingestInboundEmail: m.ingest }));
vi.mock("@/server/worker/despachar-extraccion", () => ({ dispatchExtractionWorker: m.despachar }));
vi.mock("@/server/email/gmail/gmail-client", () => ({ getGmailClient: m.getGmailClient }));
vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountByEmail: vi.fn().mockResolvedValue(null),
  listEnabledGmailAccounts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/email/gmail/poll-state", () => ({
  getOrCreatePollState: vi.fn().mockResolvedValue({ id: "poll-state-uuid", historyId: "12345", pendientes: [] }),
  advancePollState: vi.fn().mockResolvedValue(undefined),
  recordPollError: vi.fn().mockResolvedValue(undefined),
  guardarPendientes: vi.fn().mockResolvedValue(undefined),
  MAX_INTENTOS_POR_MENSAJE: 3,
}));
vi.mock("@/server/email/gmail/gmail-attachment-adapter", () => ({ adaptGmailAttachments: m.adaptar }));
vi.mock("@/server/email/rehost-attachments", () => ({ rehostAndRecordAttachments: m.guardarAdjuntos }));
vi.mock("@/server/email/dedupe", () => ({ checkDuplicate: vi.fn().mockResolvedValue(false) }));

import { pollGmail } from "@/server/email/gmail/gmail-poller";

const TENANT_ID = "00000000-0000-0000-0000-000000000000";
const CASE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MSG_ID = "gmail-msg-id-001";
const ADJUNTO = { filename: "foto.jpg", mimeType: "image/jpeg", body: { attachmentId: "att-1" } };

function gmailConUnMail(parts: unknown[]) {
  return {
    users: {
      history: {
        list: vi.fn().mockResolvedValue({
          data: { historyId: "99999", history: [{ messagesAdded: [{ message: { id: MSG_ID } }] }] },
        }),
      },
      messages: {
        get: vi.fn().mockResolvedValue({
          data: {
            id: MSG_ID,
            threadId: "thread-001",
            historyId: "99999",
            payload: {
              headers: [
                { name: "From", value: "sender@example.com" },
                { name: "To", value: "claims@claimmix.com" },
                { name: "Subject", value: "Test subject" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("Hello").toString("base64url") },
              parts,
            },
          },
        }),
        modify: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

const procesado = (excedente: boolean) => ({
  outcome: "processed",
  caseId: CASE_ID,
  claimMessageId: "claim-msg-uuid-001",
  isNewCase: false,
  excedente,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GMAIL_USER_EMAIL = "claims@claimmix.com";
  delete process.env.GMAIL_TENANT_ID;
  m.despachar.mockResolvedValue(undefined);
  m.adaptar.mockResolvedValue([{ filename: "foto.jpg" }]);
  m.guardarAdjuntos.mockResolvedValue(undefined);
});

describe("pollGmail — tope por remitente", () => {
  it("con excedente no despacha la extracción, pero cuenta el mail como procesado y lo marca leído", async () => {
    const gmail = gmailConUnMail([]);
    m.getGmailClient.mockReturnValue(gmail);
    m.ingest.mockResolvedValue(procesado(true));

    const resultado = await pollGmail();

    expect(m.ingest).toHaveBeenCalledTimes(1);
    expect(m.despachar).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ processed: 1 });
    expect(gmail.users.messages.modify).toHaveBeenCalledTimes(1);
  });

  it("con excedente igual baja y guarda los adjuntos", async () => {
    m.getGmailClient.mockReturnValue(gmailConUnMail([ADJUNTO]));
    m.ingest.mockResolvedValue(procesado(true));

    await pollGmail();

    expect(m.adaptar).toHaveBeenCalledTimes(1);
    expect(m.guardarAdjuntos).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, caseId: CASE_ID, messageId: "claim-msg-uuid-001" })
    );
    expect(m.despachar).not.toHaveBeenCalled();
  });

  it("sin excedente despacha, como siempre", async () => {
    m.getGmailClient.mockReturnValue(gmailConUnMail([ADJUNTO]));
    m.ingest.mockResolvedValue(procesado(false));

    await pollGmail();

    expect(m.adaptar).toHaveBeenCalledTimes(1);
    expect(m.despachar).toHaveBeenCalledTimes(1);
    expect(m.despachar).toHaveBeenCalledWith(CASE_ID, TENANT_ID);
  });

  it("le pide al ingreso el canal real, que es el que tiene tope", async () => {
    m.getGmailClient.mockReturnValue(gmailConUnMail([]));
    m.ingest.mockResolvedValue(procesado(false));

    await pollGmail();

    expect(m.ingest).toHaveBeenCalledWith(expect.objectContaining({ channel: "email", tenantId: TENANT_ID }));
  });
});
