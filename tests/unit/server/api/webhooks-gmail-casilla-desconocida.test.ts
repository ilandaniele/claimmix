/**
 * POST /api/webhooks/gmail — aviso por una dirección que no es una casilla conectada.
 *
 * Con casillas de inquilinos conectadas, la del .env ya no cuenta (el cron
 * tampoco la mira en ese estado). Un aviso por otra dirección se acusa y se
 * tira: no dispara la lectura de la casilla heredada.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { MockOAuth2Client, mockPollGmail, mockListEnabledGmailAccounts } = vi.hoisted(() => {
  const MockOAuth2Client = vi.fn(function (this: unknown) {
    (this as Record<string, unknown>).verifyIdToken = vi.fn();
  });
  const mockPollGmail = vi.fn();
  const mockListEnabledGmailAccounts = vi.fn().mockResolvedValue([]);
  return { MockOAuth2Client, mockPollGmail, mockListEnabledGmailAccounts };
});

vi.mock("google-auth-library", () => ({
  OAuth2Client: MockOAuth2Client,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/server/email/gmail/gmail-poller", () => ({
  pollGmail: mockPollGmail,
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  listEnabledGmailAccounts: mockListEnabledGmailAccounts,
}));

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  tables: {},
}));

const CASILLA = {
  id: "ga-1",
  tenantId: "aaaaaaaa-0000-0000-0000-00000000000a",
  email: "casilla@aseguradora.com",
  refreshToken: "fake-refresh-token",
  enabled: true,
};

function buildEnvelope(emailAddress: string, historyId = "999"): Record<string, unknown> {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64");
  return {
    message: { data, messageId: "msg-001", publishTime: "2026-06-04T18:00:00Z" },
    subscription: "projects/p/subscriptions/s",
  };
}

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/webhooks/gmail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhooks/gmail — casilla desconocida", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBSUB_AUDIENCE;
    delete process.env.PUBSUB_SERVICE_ACCOUNT;
    mockPollGmail.mockResolvedValue({ processed: 0 });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("con casillas conectadas, un aviso por otra dirección se acusa y NO dispara la lectura del .env", async () => {
    mockListEnabledGmailAccounts.mockResolvedValue([CASILLA]);
    const { POST } = await import("@/app/api/webhooks/gmail/route");

    const res = await POST(buildRequest(buildEnvelope("test@example.com")));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockPollGmail).not.toHaveBeenCalled();
  });

  it("control: el aviso por una casilla conectada lee esa casilla, sin importar mayúsculas", async () => {
    mockListEnabledGmailAccounts.mockResolvedValue([CASILLA]);
    const { POST } = await import("@/app/api/webhooks/gmail/route");

    await POST(buildRequest(buildEnvelope("Casilla@Aseguradora.com")));

    expect(mockPollGmail).toHaveBeenCalledWith({
      tenantId: CASILLA.tenantId,
      email: CASILLA.email,
      refreshToken: CASILLA.refreshToken,
    });
  });

  it("control: sin ninguna casilla conectada sigue leyendo la del .env", async () => {
    mockListEnabledGmailAccounts.mockResolvedValue([]);
    const { POST } = await import("@/app/api/webhooks/gmail/route");

    const res = await POST(buildRequest(buildEnvelope("test@example.com")));

    expect((await res.json()).ok).toBe(true);
    expect(mockPollGmail).toHaveBeenCalledWith();
  });
});
