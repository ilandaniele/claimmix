/**
 * Unit tests for claim_messages-based dedupe helpers.
 *
 * Tests:
 *   - checkDuplicate() returns true when a matching row exists in claim_messages
 *   - checkDuplicate() returns false when no row exists
 *   - checkDuplicate() returns false (fail-open) on Supabase error
 *   - normalizeMessageId() strips angle brackets
 *   - normalizeMessageId() is idempotent (no-op when no brackets present)
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

// Import after mocks are set up
import { checkDuplicate, normalizeMessageId } from "@/server/email/dedupe";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock Supabase client chain that resolves to the given data/error. */
function makeSupabaseMock(opts: {
  data: unknown;
  error: { code: string } | null;
}): ReturnType<typeof import("@/lib/supabase/service").createServiceClient> {
  const chain: any = {
    eq: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: opts.data, error: opts.error }),
  };
  const mock: any = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(chain),
    }),
  };
  return mock;
}

// ── normalizeMessageId ────────────────────────────────────────────────────────

describe("normalizeMessageId", () => {
  it("strips leading and trailing angle brackets", () => {
    expect(normalizeMessageId("<abc@mail.postmarkapp.com>")).toBe(
      "abc@mail.postmarkapp.com"
    );
  });

  it("is a no-op when no brackets are present", () => {
    expect(normalizeMessageId("abc@mail.postmarkapp.com")).toBe(
      "abc@mail.postmarkapp.com"
    );
  });

  it("handles double brackets", () => {
    expect(normalizeMessageId("<<abc@mail>>")).toBe("abc@mail");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeMessageId("  <abc@mail>  ")).toBe("abc@mail");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeMessageId("")).toBe("");
  });

  it("preserves special chars inside the id", () => {
    expect(normalizeMessageId("<MessageID-Example@example.com>")).toBe(
      "MessageID-Example@example.com"
    );
  });
});

// ── checkDuplicate ────────────────────────────────────────────────────────────

describe("checkDuplicate", () => {
  it("returns true when a matching claim_messages row exists", async () => {
    const supabase = makeSupabaseMock({
      data: { id: "msg-uuid-001" },
      error: null,
    });

    const result = await checkDuplicate(supabase, "tenant-001", "msg-abc-123");
    expect(result).toBe(true);
  });

  it("returns false when no matching claim_messages row exists (maybeSingle returns null)", async () => {
    const supabase = makeSupabaseMock({
      data: null,
      error: null,
    });

    const result = await checkDuplicate(supabase, "tenant-001", "msg-abc-123");
    expect(result).toBe(false);
  });

  it("returns false (fail-open) when Supabase returns an error", async () => {
    const supabase = makeSupabaseMock({
      data: null,
      error: { code: "PGRST202" },
    });

    const result = await checkDuplicate(supabase, "tenant-001", "msg-abc-123");
    expect(result).toBe(false);
  });

  it("queries the claim_messages table with the correct tenant_id and provider_message_id", async () => {
    const chain: any = {
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const selectFn = vi.fn().mockReturnValue(chain);
    const fromFn = vi.fn().mockReturnValue({ select: selectFn });
    const supabase: any = { from: fromFn };

    await checkDuplicate(supabase, "tenant-xyz", "msg-id-001");

    expect(fromFn).toHaveBeenCalledWith("claim_messages");
    expect(selectFn).toHaveBeenCalledWith("id");
    // eq called twice: tenant_id, provider_message_id
    expect(chain.eq).toHaveBeenCalledWith("tenant_id", "tenant-xyz");
    expect(chain.eq).toHaveBeenCalledWith("provider_message_id", "msg-id-001");
  });

  it("is scoped per-tenant: same message_id under different tenant is not a duplicate", async () => {
    // First tenant: no duplicate
    const supabaseA = makeSupabaseMock({ data: null, error: null });
    expect(await checkDuplicate(supabaseA, "tenant-a", "msg-123")).toBe(false);

    // Second tenant: duplicate exists
    const supabaseB = makeSupabaseMock({ data: { id: "row-1" }, error: null });
    expect(await checkDuplicate(supabaseB, "tenant-b", "msg-123")).toBe(true);
  });
});
