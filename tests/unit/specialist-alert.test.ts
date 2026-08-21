/**
 * Telling a person a claim needs them — and not telling them about a rehearsal.
 *
 * This is the one path in the product that reaches a human directly, and until
 * today it was the only one with no tests. It showed: a batch simulation
 * escalated thirty-five invented claims in four minutes and seventeen real
 * emails landed in a real inbox. "[Urgente] Siniestro de incendio derivado a
 * especialista", seventeen times, about fires that never happened.
 *
 * Everything else already knew. The WhatsApp messenger refuses to write to an
 * invented number; the email dispatcher refuses to send to @example.com. This
 * had simply never been told, and it was the one that mattered most.
 */

const { mockSelect, mockGetAccount, mockSend, mockAudit } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSend: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { select: mockSelect } }));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: mockGetAccount,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: class {
    send = mockSend;
  },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockAudit,
  AuditEvent: { SPECIALIST_ALERTED: "claim.specialist_alerted" },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { alertSpecialists } from "@/server/notify/specialist-alert";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";

/**
 * The module makes three different selects. They are told apart by the shape
 * of the chain, which is the only thing distinguishing them from outside:
 *   channel  → select().from().where().limit()
 *   already  → select().from().where().limit()  (audit_log)
 *   people   → select().from().innerJoin().where()
 */
function database(opts: { channel?: string; alreadySent?: boolean; staff?: string[] }) {
  const channel = opts.channel ?? "email";
  const staff = opts.staff ?? ["analista@aseguradora.com"];
  let call = 0;

  mockSelect.mockImplementation(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => Promise.resolve(staff.map((email) => ({ email }))),
      }),
      where: () => ({
        limit: () => {
          call += 1;
          // First: the case's channel. Second: has an alert already gone out.
          if (call === 1) return Promise.resolve([{ channel }]);
          return Promise.resolve(opts.alreadySent ? [{ id: 1 }] : []);
        },
      }),
    }),
  }));
}

function alert() {
  return alertSpecialists({
    caseId: CASE,
    tenantId: TENANT,
    severity: "critical",
    claimTypeLabel: "incendio",
    summary: "Se prendió fuego el auto en la ruta 3.",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAccount.mockResolvedValue({
    email: "siniestros@aseguradora.com",
    refreshToken: "token",
  });
  mockSend.mockResolvedValue({ providerMessageId: "sent-1" });
  mockAudit.mockResolvedValue(undefined);
});

describe("alertSpecialists — a real claim", () => {
  it("emails the people who can act on it", async () => {
    database({ channel: "email" });

    await alert();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toContain("analista@aseguradora.com");
  });

  it("does it for WhatsApp claims too", async () => {
    database({ channel: "whatsapp" });

    await alert();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("records that someone was told, without listing who", async () => {
    // An audit trail should prove a person was informed without becoming a
    // directory of staff email addresses.
    database({ channel: "email", staff: ["a@x.com", "b@x.com"] });

    await alert();

    const entry = mockAudit.mock.calls[0][0];
    expect(entry.payload).toMatchObject({ recipients: 2, delivered: true });
    expect(JSON.stringify(entry.payload)).not.toContain("@x.com");
  });

  it("does not tell them twice about the same case", async () => {
    database({ channel: "email", alreadySent: true });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("alertSpecialists — a simulation", () => {
  it("does not email anyone about a simulated email case", async () => {
    // The bug, exactly: seventeen of these reached a real inbox.
    database({ channel: "email_sim" });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("does not email anyone about a simulated WhatsApp case", async () => {
    database({ channel: "whatsapp_sim" });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("stays quiet when it cannot tell what the case is", async () => {
    // Fail towards silence. A missed alert on a real claim leaves a case
    // sitting in requiere_especialista that somebody finds; a flood of urgent
    // emails about fires that did not happen is how an insurer stops trusting
    // the product.
    mockSelect.mockImplementation(() => {
      throw new Error("connection lost");
    });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("alertSpecialists — when it cannot do its job", () => {
  it("says so loudly when nobody is configured to receive it", async () => {
    // The claimant has been promised a specialist will call. If no address
    // exists, that promise has no owner and the only trace is this line.
    database({ channel: "email", staff: [] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).toContain("no_recipients");
    spy.mockRestore();
  });

  it("says so loudly when there is no mailbox to send from", async () => {
    database({ channel: "email" });
    mockGetAccount.mockResolvedValue(null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await alert();

    expect(spy.mock.calls.flat().join(" ")).toContain("no_mailbox");
    spy.mockRestore();
  });

  it("never throws — the claim is already escalated", async () => {
    database({ channel: "email" });
    mockSend.mockRejectedValue(new Error("gmail down"));

    await expect(alert()).resolves.toBeUndefined();
  });
});
