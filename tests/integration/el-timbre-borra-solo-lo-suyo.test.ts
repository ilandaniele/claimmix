/**
 * `POST /api/health/knock`, acción `trash`: sólo borra lo que el timbre insertó.
 *
 * El endpoint recibía un `message_id` y lo mandaba directo a
 * `gmail.users.messages.trash` sin comprobar de quién era. Vive detrás de
 * `CRON_SECRET`, así que el panel del escaneo no lo marcó como hallazgo, pero
 * «borrá este id» no debería alcanzar para borrar cualquier mensaje de la
 * casilla. Ahora primero pide los metadatos del mensaje y sólo borra si el
 * asunto lleva la marca `[timbre `.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock de googleapis: mismo patrón que tests/unit/gmail-sender.test.ts ──────

const { mockMessagesGet, mockMessagesTrash, MockOAuth2, mockGmailFn } = vi.hoisted(() => {
  const mockMessagesGet = vi.fn();
  const mockMessagesTrash = vi.fn();
  const MockOAuth2 = vi.fn(function (this: unknown) {
    return { setCredentials: vi.fn() };
  });
  const mockGmailFn = vi.fn();
  return { mockMessagesGet, mockMessagesTrash, MockOAuth2, mockGmailFn };
});

vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: MockOAuth2 },
    gmail: mockGmailFn,
  },
}));

function setupGmailMock() {
  mockGmailFn.mockReturnValue({
    users: {
      messages: {
        get: mockMessagesGet,
        trash: mockMessagesTrash,
      },
    },
  });
}

// ── Mock de la cuenta: no hace falta pasar por enTenant/la tabla real ─────────

const { mockGetGmailAccountForTenant } = vi.hoisted(() => ({
  mockGetGmailAccountForTenant: vi.fn(),
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: mockGetGmailAccountForTenant,
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/health/knock/route";

const SECRETO = "secreto-de-prueba";
const TENANT = "tenant-uuid-001";
const MSG_ID = "gmail-msg-a-borrar";

function pedir(body: unknown) {
  return new NextRequest("http://localhost/api/health/knock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRETO}`,
    },
    body: JSON.stringify(body),
  });
}

/** Un mensaje con el asunto que pida el test, como devolvería `messages.get`. */
function mensajeConAsunto(subject: string) {
  return { data: { payload: { headers: [{ name: "Subject", value: subject }] } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupGmailMock();
  vi.stubEnv("CRON_SECRET", SECRETO);
  vi.stubEnv("GMAIL_TENANT_ID", TENANT);
  vi.stubEnv("GMAIL_CLIENT_ID", "test-client-id");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "test-client-secret");
  mockGetGmailAccountForTenant.mockResolvedValue({
    id: "account-1",
    tenantId: TENANT,
    email: "casilla@example.com",
    refreshToken: "refresh-token-de-prueba",
    enabled: true,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const { resetGmailAuth } = await import("@/server/email/gmail/gmail-client");
  resetGmailAuth();
});

describe("POST /api/health/knock (trash)", () => {
  it("un id sin la marca del timbre en el asunto es 404 y no borra", async () => {
    mockMessagesGet.mockResolvedValue(mensajeConAsunto("Un mail cualquiera de la casilla"));

    const res = await POST(pedir({ action: "trash", message_id: MSG_ID }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(mockMessagesTrash).not.toHaveBeenCalled();
  });

  it("un id con «[timbre » en el asunto sí borra", async () => {
    mockMessagesGet.mockResolvedValue(mensajeConAsunto("Choque en Bahia Blanca [timbre abc]"));

    const res = await POST(pedir({ action: "trash", message_id: MSG_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, trashed: MSG_ID });
    expect(mockMessagesTrash).toHaveBeenCalledWith({ userId: "me", id: MSG_ID });
  });
});
