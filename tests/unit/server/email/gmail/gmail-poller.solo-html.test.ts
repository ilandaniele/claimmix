/**
 * Un mail que vino sólo en HTML (H32).
 *
 * La extracción lee `body_text`. Sin parte text/plain quedaba vacío y el agente
 * contestaba como si el mail no dijera nada: el texto sale del HTML, sin
 * etiquetas, sin el código ni los estilos, con las entidades decodificadas.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ingest: vi.fn(),
  getGmailClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/email/inbound-email", () => ({ ingestInboundEmail: m.ingest }));
vi.mock("@/server/worker/despachar-extraccion", () => ({ dispatchExtractionWorker: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock("@/server/email/gmail/gmail-attachment-adapter", () => ({ adaptGmailAttachments: vi.fn().mockResolvedValue([]) }));
vi.mock("@/server/email/rehost-attachments", () => ({ rehostAndRecordAttachments: vi.fn() }));
vi.mock("@/server/email/dedupe", () => ({ checkDuplicate: vi.fn().mockResolvedValue(false) }));

import { pollGmail } from "@/server/email/gmail/gmail-poller";

const MSG_ID = "gmail-msg-id-001";
const HTML =
  "<html><head><title>Denuncia</title><style>p { color: red }</style></head>" +
  "<body><!-- firma --><p>Choqu&eacute; en Bah&#237;a Blanca &amp; necesito\n  hacer la denuncia.</p>" +
  "<div>Patente <b>AB123CD</b>&nbsp;&#x2014; p&oacute;liza &lt;1234&gt;</div>" +
  "<script>alert('x')</script><br>Saludos</body></html>";

const base64url = (texto: string) => Buffer.from(texto).toString("base64url");

function gmailConUnMail(payload: Record<string, unknown>) {
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
                { name: "To", value: "claims@example.com" },
                { name: "Subject", value: "Denuncia" },
              ],
              ...payload,
            },
          },
        }),
        modify: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GMAIL_USER_EMAIL = "claims@example.com";
  delete process.env.GMAIL_TENANT_ID;
  m.ingest.mockResolvedValue({ outcome: "skipped", reason: "prefilter" });
});

describe("pollGmail — mail sólo en HTML", () => {
  it("sin text/plain, el texto sale del HTML", async () => {
    m.getGmailClient.mockReturnValue(gmailConUnMail({ mimeType: "text/html", body: { data: base64url(HTML) } }));

    await pollGmail();

    expect(m.ingest).toHaveBeenCalledTimes(1);
    const { bodyText, bodyHtml } = m.ingest.mock.calls[0]![0];
    expect(bodyText).toBe(
      "Choqué en Bahía Blanca & necesito hacer la denuncia.\nPatente AB123CD — póliza <1234>\nSaludos"
    );
    expect(bodyHtml).toBe(HTML);
  });

  it("con text/plain, manda el text/plain", async () => {
    m.getGmailClient.mockReturnValue(
      gmailConUnMail({
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: base64url("Choqué en Bahía Blanca.") } },
          { mimeType: "text/html", body: { data: base64url(HTML) } },
        ],
      })
    );

    await pollGmail();

    expect(m.ingest.mock.calls[0]![0].bodyText).toBe("Choqué en Bahía Blanca.");
  });

  it("un <script> sin cierre no se come el resto ni lo recorre de nuevo", async () => {
    const html = "<p>Hola</p>" + "<script>".repeat(50_000) + "<p>Choque</p>";
    m.getGmailClient.mockReturnValue(gmailConUnMail({ mimeType: "text/html", body: { data: base64url(html) } }));

    const inicio = performance.now();
    await pollGmail();

    expect(performance.now() - inicio).toBeLessThan(2_000);
    expect(m.ingest.mock.calls[0]![0].bodyText).toBe("Hola\nChoque");
  });
});
