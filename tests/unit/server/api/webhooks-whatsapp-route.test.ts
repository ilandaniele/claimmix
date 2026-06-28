/**
 * Unit tests for /api/webhooks/whatsapp — both auth paths.
 *
 * Path 1: Meta Cloud API (GET verification handshake + signed POST).
 * Path 2: normalized payload + Bearer secret (simulation / BSP adapters).
 *
 * The real cloud-api helpers run (signature math is part of what we're testing);
 * only the DB-backed intake + agent are mocked.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

const { afterCallbacks, mockAfter, mockCreateWhatsAppIntake, mockRunIntakeAgent } = vi.hoisted(() => {
  const afterCallbacks: Array<() => unknown | Promise<unknown>> = [];
  return {
    afterCallbacks,
    mockAfter: vi.fn((cb: () => unknown | Promise<unknown>) => { afterCallbacks.push(cb); }),
    mockCreateWhatsAppIntake: vi.fn(),
    mockRunIntakeAgent: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mockAfter };
});
vi.mock("@/server/agents/intake-agent", () => ({
  createWhatsAppIntake: mockCreateWhatsAppIntake,
  runIntakeAgent: mockRunIntakeAgent,
}));

import { GET, POST } from "@/app/api/webhooks/whatsapp/route";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "verify-tok";
const TENANT = "10000000-0000-0000-0000-000000000001";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

function metaReq(rawBody: string, signature: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-hub-signature-256"] = signature;
  return new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", headers, body: rawBody });
}

const TEXT_PAYLOAD = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: "5492916426930", profile: { name: "Ilan" } }],
    messages: [{ from: "5492916426930", id: "wamid.1", type: "text", text: { body: "Tuve un choque" } }],
  } }] }],
});

describe("/api/webhooks/whatsapp", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    process.env.WHATSAPP_TENANT_ID = TENANT;
    process.env.WHATSAPP_WEBHOOK_SECRET = "bearer-secret";
    mockCreateWhatsAppIntake.mockResolvedValue({ caseId: "case-1", tenantId: TENANT, created: true });
    mockRunIntakeAgent.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  // ── GET verification handshake ──────────────────────────────────────────────

  it("echoes hub.challenge when the verify token matches", () => {
    const req = new NextRequest(
      `http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`
    );
    const res = GET(req);
    expect(res.status).toBe(200);
  });

  it("rejects the handshake with a 403 on token mismatch", () => {
    const req = new NextRequest(
      "http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"
    );
    expect(GET(req).status).toBe(403);
  });

  // ── Meta Cloud API POST ─────────────────────────────────────────────────────

  it("rejects an unsigned Cloud-API-shaped POST is treated as the bearer path (401 without bearer)", async () => {
    const res = await POST(metaReq(TEXT_PAYLOAD, null));
    expect(res.status).toBe(401); // no signature, no bearer
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  it("rejects a POST with an invalid signature (401)", async () => {
    const res = await POST(metaReq(TEXT_PAYLOAD, "sha256=" + "0".repeat(64)));
    expect(res.status).toBe(401);
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  it("ingests a validly-signed text message and schedules the agent", async () => {
    const res = await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, received: 1, case_ids: ["case-1"] });

    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, from: "5492916426930", providerMessageId: "wamid.1" })
    );
    // Agent runs only after the response is flushed.
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
    await afterCallbacks[0]();
    expect(mockRunIntakeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-1", tenantId: TENANT, source: "whatsapp" })
    );
  });

  it("ACKs a validly-signed status event (no messages) without creating a case", async () => {
    const statusBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    });
    const res = await POST(metaReq(statusBody, sign(statusBody)));
    expect(res.status).toBe(200);
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  // ── Normalized + Bearer POST ────────────────────────────────────────────────

  it("accepts the normalized payload with a valid Bearer secret", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bearer-secret" },
      body: JSON.stringify({ from: "5492916426930", body: "Choque en la ruta 3" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(
      expect.objectContaining({ from: "5492916426930", body: "Choque en la ruta 3" })
    );
  });
});
