/**
 * Integration tests for GET /api/cases/[id]/messages.
 *
 * AC8: Returns 200 + messages array with all required fields.
 * AC9: Returns 404 NOT_FOUND when case belongs to a different tenant (IDOR safe).
 * AC10: Returns 200 + { messages: [] } when no claim_messages rows exist.
 * AC13: body_text is truncated to 500 chars server-side.
 * AC14: attachment_count is populated from claim_attachments join.
 *
 * Runs against a mock Next.js request context using vi.mock for Supabase clients.
 * This avoids a live server dependency while still exercising route handler logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type NextRequest } from "next/server";

// ── Mock Supabase clients ─────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(),
}));

// Mock rate-limit to always allow (not testing rate-limit in this suite).
vi.mock("@/lib/rate-limit/index", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit/index")>(
    "@/lib/rate-limit/index"
  );
  return {
    ...actual,
    rateLimit: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 99,
      resetAt: 0,
      retryAfterSeconds: 0,
    }),
  };
});

import { createServerClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/cases/[id]/messages/route";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-001";
const USER_ID = "user-uuid-001";
const CASE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const OTHER_CASE_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

function makeMessage(overrides: Partial<{
  id: string;
  direction: string;
  provider: string;
  subject: string | null;
  from_addr: string | null;
  body_text: string | null;
  received_at: string;
  claim_attachments: Array<{ id: string }>;
}> = {}) {
  return {
    id: "msg-uuid-001",
    direction: "inbound",
    provider: "gmail",
    subject: "Test subject",
    from_addr: "claimant@example.com",
    body_text: "Hello, this is the body of the email.",
    received_at: "2026-06-01T10:00:00Z",
    claim_attachments: [],
    ...overrides,
  };
}

// ── Mock Supabase builder ─────────────────────────────────────────────────────

/**
 * Builds a mock Supabase server client.
 *
 * @param userPresent - whether auth.getUser() returns a user
 * @param caseExists  - whether the case lookup returns a row
 * @param messages    - the claim_messages rows to return
 */
function buildClientMock(
  userPresent: boolean,
  caseExists: boolean,
  messages: ReturnType<typeof makeMessage>[] = []
) {
  const userId = userPresent ? USER_ID : null;
  const user = userPresent
    ? { id: userId, email: "test@example.com" }
    : null;

  // We need to model two sequential .from() calls:
  // 1. .from("cases").select("id").eq("id", ...).maybeSingle()
  // 2. .from("claim_messages").select(...).eq(...).order(...).limit(...)
  //
  // Use a call counter to return different data for each .from() call.
  let callCount = 0;

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user },
        error: null,
      }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      callCount++;

      if (table === "cases") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: caseExists ? { id: CASE_ID } : null,
            error: null,
          }),
        };
      }

      if (table === "claim_messages") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: messages,
            error: null,
          }),
        };
      }

      // Fallback
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    }),
  };
}

/** Build a fake NextRequest for the route handler. */
function buildRequest(): NextRequest {
  return new Request("http://localhost/api/cases/" + CASE_ID + "/messages") as NextRequest;
}

/** Build the route context with params as a Promise (Next.js 16 convention). */
function buildContext(id: string) {
  return {
    params: Promise.resolve({ id }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/cases/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC8: returns 200 with messages array when case is owned and messages exist", async () => {
    const messages = [
      makeMessage({ id: "msg-001", received_at: "2026-06-01T08:00:00Z" }),
      makeMessage({ id: "msg-002", received_at: "2026-06-01T09:00:00Z" }),
      makeMessage({ id: "msg-003", received_at: "2026-06-01T10:00:00Z" }),
    ];

    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, true, messages)
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages).toHaveLength(3);

    // AC8: each entry has all required fields
    const entry = body.messages[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("direction");
    expect(entry).toHaveProperty("provider");
    expect(entry).toHaveProperty("subject");
    expect(entry).toHaveProperty("from_addr");
    expect(entry).toHaveProperty("body_text");
    expect(entry).toHaveProperty("received_at");
    expect(entry).toHaveProperty("attachment_count");
  });

  it("AC9: returns 404 NOT_FOUND for case belonging to a different tenant (IDOR safe)", async () => {
    // Case lookup returns null — simulates RLS returning no row for wrong tenant.
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, false, [])
    );

    const response = await GET(buildRequest(), buildContext(OTHER_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    // AC9: no message data in the body
    expect(body).not.toHaveProperty("messages");
  });

  it("AC10: returns 200 with empty array when no claim_messages rows exist", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, true, [])
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ messages: [] });
  });

  it("returns 401 MISSING_SESSION when not authenticated", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(false, false, [])
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  it("returns 404 for invalid (non-UUID) case ID", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, false, [])
    );

    const response = await GET(buildRequest(), buildContext("not-a-uuid"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("AC13: body_text is truncated to 500 chars when input exceeds 500 chars", async () => {
    const longBody = "x".repeat(800);
    const messages = [makeMessage({ body_text: longBody })];

    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, true, messages)
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages).toHaveLength(1);
    // body_text must be at most 500 chars
    expect(body.messages[0].body_text.length).toBe(500);
    expect(body.messages[0].body_text).toBe("x".repeat(500));
  });

  it("AC13: body_text is NOT truncated when under 500 chars", async () => {
    const shortBody = "y".repeat(200);
    const messages = [makeMessage({ body_text: shortBody })];

    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, true, messages)
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].body_text).toBe(shortBody);
    expect(body.messages[0].body_text.length).toBe(200);
  });

  it("AC14: attachment_count is populated from claim_attachments join", async () => {
    const messages = [
      makeMessage({
        id: "msg-with-attachments",
        claim_attachments: [{ id: "att-001" }, { id: "att-002" }],
      }),
    ];

    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, true, messages)
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].attachment_count).toBe(2);
  });

  it("AC14: attachment_count is 0 when no attachments exist", async () => {
    const messages = [makeMessage({ claim_attachments: [] })];

    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, true, messages)
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].attachment_count).toBe(0);
  });

  it("body_text handles null gracefully — returns null in response", async () => {
    const messages = [makeMessage({ body_text: null })];

    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildClientMock(true, true, messages)
    );

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].body_text).toBeNull();
  });
});
