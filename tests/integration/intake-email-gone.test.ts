/**
 * Integration tests for AC11: /api/intake/email 410 Gone stub.
 *
 * AC11: Old Postmark webhook returns 410 Gone:
 *   GIVEN the old /api/intake/email route
 *   WHEN any HTTP method is invoked against it
 *   THEN response is 410 with { error: { code: "GONE", message: "..." } }
 *   AND no HMAC verification or Postmark parsing is attempted
 *   AND no claim_messages rows are inserted
 *
 * The tests call the route handlers directly (no live server) and verify:
 *   - 410 status for GET, POST, PUT, PATCH, DELETE
 *   - Response body shape matches error contract
 *   - postmark-specific modules are NOT called
 */

import { describe, it, expect, vi } from "vitest";

// ── Verify postmark-specific code is NOT loaded ───────────────────────────────
// These mocks would fail the test if the route called them.
vi.mock("@/server/email/verify-postmark-signature", () => ({
  verifyPostmarkSignature: vi.fn().mockImplementation(() => {
    throw new Error("verifyPostmarkSignature should NOT be called by 410 stub");
  }),
}));

vi.mock("@/lib/schemas/postmark-inbound", () => ({
  PostmarkInboundSchema: {
    safeParse: vi.fn().mockImplementation(() => {
      throw new Error("PostmarkInboundSchema should NOT be called by 410 stub");
    }),
  },
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn().mockImplementation(() => {
    throw new Error("createServiceClient should NOT be called by 410 stub");
  }),
}));

// ── Import route under test AFTER mocks ──────────────────────────────────────

import { GET, POST, PUT, PATCH, DELETE } from "@/app/api/intake/email/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const EXPECTED_BODY = {
  error: {
    code: "GONE",
    message: "Postmark intake disabled; using Gmail polling",
  },
};

async function expectGone(handler: () => Promise<Response>): Promise<void> {
  const res = await handler();
  expect(res.status).toBe(410);
  const body = await res.json();
  expect(body).toEqual(EXPECTED_BODY);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("/api/intake/email — 410 Gone stub (AC11)", () => {
  it("GET returns 410 Gone", async () => {
    await expectGone(() => GET());
  });

  it("POST returns 410 Gone", async () => {
    await expectGone(() => POST());
  });

  it("PUT returns 410 Gone", async () => {
    await expectGone(() => PUT());
  });

  it("PATCH returns 410 Gone", async () => {
    await expectGone(() => PATCH());
  });

  it("DELETE returns 410 Gone", async () => {
    await expectGone(() => DELETE());
  });

  it("response Content-Type is application/json", async () => {
    const res = await POST();
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/application\/json/);
  });

  it("body has correct error code and message", async () => {
    const res = await POST();
    const body = await res.json();
    expect(body.error.code).toBe("GONE");
    expect(body.error.message).toContain("Gmail polling");
  });
});
