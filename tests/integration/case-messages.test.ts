/**
 * Integration tests for GET /api/cases/[id]/messages.
 *
 * AC8: Returns 200 + messages array with all required fields.
 * AC9: Returns 404 NOT_FOUND when case belongs to a different tenant (IDOR safe).
 * AC10: Returns 200 + { messages: [] } when no claim_messages rows exist.
 * AC13: body_text is truncated to 500 chars server-side.
 * AC14: attachment_count is populated from claim_attachments join.
 *
 * Uses vi.mock("@/lib/db") and vi.mock("@/lib/auth/require-role") to exercise
 * route handler logic without a live DB or server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type NextRequest } from "next/server";

// ── Mocks must be hoisted before any imports that use them ────────────────────

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
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

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/require-role";
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
}> = {}) {
  return {
    id: "msg-uuid-001",
    direction: "inbound",
    provider: "gmail",
    subject: "Test subject",
    from_addr: "claimant@example.com",
    body_text: "Hello, this is the body of the email.",
    received_at: "2026-06-01T10:00:00Z",
    ...overrides,
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

/**
 * Set up requireRole to return a valid session context.
 */
function setupAuth() {
  vi.mocked(requireRole).mockResolvedValue({
    user: { id: USER_ID, email: "test@example.com" },
    userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst" },
  });
}

/**
 * Set up requireRole to throw (unauthenticated).
 */
function setupNoAuth() {
  vi.mocked(requireRole).mockRejectedValue(new Error("MISSING_SESSION"));
}

/**
 * Build a chainable db.select mock that resolves with the given rows.
 * The route calls db.select().from().where().orderBy().limit() for messages
 * and db.select().from().where() for case lookup and attachments.
 */
function buildSelectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    // Make the chain itself thenable so it resolves when not calling .limit()
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  return chain;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/cases/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset only the db.select queue so mockReturnValueOnce calls don't bleed between tests.
    vi.mocked(db.select).mockReset();
  });

  it("AC8: returns 200 with messages array when case is owned and messages exist", async () => {
    setupAuth();

    const messages = [
      makeMessage({ id: "msg-001", received_at: "2026-06-01T08:00:00Z" }),
      makeMessage({ id: "msg-002", received_at: "2026-06-01T09:00:00Z" }),
      makeMessage({ id: "msg-003", received_at: "2026-06-01T10:00:00Z" }),
    ];

    // db.select() is called 3 times:
    // 1. case lookup  -> returns [{ id: CASE_ID }]
    // 2. messages     -> returns messages array
    // 3. attachments  -> returns [] (no attachments)
    vi.mocked(db.select)
      .mockReturnValueOnce(buildSelectChain([{ id: CASE_ID }]))
      .mockReturnValueOnce(buildSelectChain(messages))
      .mockReturnValueOnce(buildSelectChain([]));

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
    setupAuth();

    // Case lookup returns empty array (no row for this tenant).
    vi.mocked(db.select).mockReturnValueOnce(buildSelectChain([]));

    const response = await GET(buildRequest(), buildContext(OTHER_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    // AC9: no message data in the body
    expect(body).not.toHaveProperty("messages");
  });

  it("AC10: returns 200 with empty array when no claim_messages rows exist", async () => {
    setupAuth();

    // 1. case lookup -> found
    // 2. messages    -> empty
    vi.mocked(db.select)
      .mockReturnValueOnce(buildSelectChain([{ id: CASE_ID }]))
      .mockReturnValueOnce(buildSelectChain([]));

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ messages: [] });
  });

  it("returns 401 MISSING_SESSION when not authenticated", async () => {
    setupNoAuth();

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  it("returns 404 for invalid (non-UUID) case ID", async () => {
    setupAuth();

    const response = await GET(buildRequest(), buildContext("not-a-uuid"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("AC13: body_text is truncated to 500 chars when input exceeds 500 chars", async () => {
    setupAuth();

    const longBody = "x".repeat(800);
    const messages = [makeMessage({ body_text: longBody })];

    vi.mocked(db.select)
      .mockReturnValueOnce(buildSelectChain([{ id: CASE_ID }]))
      .mockReturnValueOnce(buildSelectChain(messages))
      .mockReturnValueOnce(buildSelectChain([]));

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages).toHaveLength(1);
    // body_text must be at most 500 chars
    expect(body.messages[0].body_text.length).toBe(500);
    expect(body.messages[0].body_text).toBe("x".repeat(500));
  });

  it("AC13: body_text is NOT truncated when under 500 chars", async () => {
    setupAuth();

    const shortBody = "y".repeat(200);
    const messages = [makeMessage({ body_text: shortBody })];

    vi.mocked(db.select)
      .mockReturnValueOnce(buildSelectChain([{ id: CASE_ID }]))
      .mockReturnValueOnce(buildSelectChain(messages))
      .mockReturnValueOnce(buildSelectChain([]));

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].body_text).toBe(shortBody);
    expect(body.messages[0].body_text.length).toBe(200);
  });

  it("AC14: attachment_count is populated from claim_attachments join", async () => {
    setupAuth();

    const msgId = "msg-with-attachments";
    const messages = [makeMessage({ id: msgId })];

    // attachments: two rows pointing to msgId
    const attachmentRows = [
      { claim_message_id: msgId },
      { claim_message_id: msgId },
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce(buildSelectChain([{ id: CASE_ID }]))
      .mockReturnValueOnce(buildSelectChain(messages))
      .mockReturnValueOnce(buildSelectChain(attachmentRows));

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].attachment_count).toBe(2);
  });

  it("AC14: attachment_count is 0 when no attachments exist", async () => {
    setupAuth();

    const messages = [makeMessage()];

    vi.mocked(db.select)
      .mockReturnValueOnce(buildSelectChain([{ id: CASE_ID }]))
      .mockReturnValueOnce(buildSelectChain(messages))
      .mockReturnValueOnce(buildSelectChain([]));

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].attachment_count).toBe(0);
  });

  it("body_text handles null gracefully — returns null in response", async () => {
    setupAuth();

    const messages = [makeMessage({ body_text: null })];

    vi.mocked(db.select)
      .mockReturnValueOnce(buildSelectChain([{ id: CASE_ID }]))
      .mockReturnValueOnce(buildSelectChain(messages))
      .mockReturnValueOnce(buildSelectChain([]));

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].body_text).toBeNull();
  });
});
