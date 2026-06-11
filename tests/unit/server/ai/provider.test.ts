/**
 * Unit tests for the per-tenant AI provider resolution (provider.ts).
 *
 * Covers:
 *  - env default (AI_PROVIDER, fallback "openai")
 *  - tenant_ai_settings row wins over env default
 *  - missing table / query error → env default (defensive)
 *  - resolveExtractionEngine: mock mode, key-based fallback, no-keys → mock
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getDefaultProvider,
  getTenantAiProvider,
  resolveExtractionEngine,
  hasProviderKey,
} from "@/server/ai/provider";
import type { SupabaseClient } from "@supabase/supabase-js";

const ENV_KEYS = [
  "AI_PROVIDER",
  "MOCK_AI",
  "AI_MOCK",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

const ORIGINAL: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

/** Supabase mock whose tenant_ai_settings query resolves with the given result. */
function supabaseWithSetting(result: {
  data: { provider: string } | null;
  error: { code?: string } | null;
}): SupabaseClient {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(result),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function supabaseThatThrows(): SupabaseClient {
  return {
    from: vi.fn().mockImplementation(() => {
      throw new Error("relation does not exist");
    }),
  } as unknown as SupabaseClient;
}

const TENANT = "10000000-0000-0000-0000-000000000001";

describe("getDefaultProvider", () => {
  it("defaults to openai when AI_PROVIDER is unset", () => {
    delete process.env.AI_PROVIDER;
    expect(getDefaultProvider()).toBe("openai");
  });

  it("honors AI_PROVIDER=gemini (case-insensitive)", () => {
    process.env.AI_PROVIDER = "GEMINI";
    expect(getDefaultProvider()).toBe("gemini");
  });

  it("falls back to openai for invalid values", () => {
    process.env.AI_PROVIDER = "claude";
    expect(getDefaultProvider()).toBe("openai");
  });
});

describe("hasProviderKey", () => {
  it("reflects key presence per provider", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.GEMINI_API_KEY;
    expect(hasProviderKey("openai")).toBe(true);
    expect(hasProviderKey("gemini")).toBe(false);
  });

  it("treats whitespace-only keys as missing", () => {
    process.env.GEMINI_API_KEY = "   ";
    expect(hasProviderKey("gemini")).toBe(false);
  });
});

describe("getTenantAiProvider", () => {
  it("returns the tenant setting when present", async () => {
    delete process.env.AI_PROVIDER;
    const supabase = supabaseWithSetting({ data: { provider: "gemini" }, error: null });
    expect(await getTenantAiProvider(supabase, TENANT)).toBe("gemini");
  });

  it("falls back to env default when no row exists", async () => {
    process.env.AI_PROVIDER = "gemini";
    const supabase = supabaseWithSetting({ data: null, error: null });
    expect(await getTenantAiProvider(supabase, TENANT)).toBe("gemini");
  });

  it("falls back to env default on query error (table missing)", async () => {
    delete process.env.AI_PROVIDER;
    const supabase = supabaseWithSetting({ data: null, error: { code: "42P01" } });
    expect(await getTenantAiProvider(supabase, TENANT)).toBe("openai");
  });

  it("never throws even when the client throws synchronously", async () => {
    delete process.env.AI_PROVIDER;
    expect(await getTenantAiProvider(supabaseThatThrows(), TENANT)).toBe("openai");
  });

  it("ignores invalid stored values", async () => {
    delete process.env.AI_PROVIDER;
    const supabase = supabaseWithSetting({ data: { provider: "llama" }, error: null });
    expect(await getTenantAiProvider(supabase, TENANT)).toBe("openai");
  });
});

describe("resolveExtractionEngine", () => {
  it("returns mock when MOCK_AI=true regardless of keys", async () => {
    process.env.MOCK_AI = "true";
    process.env.OPENAI_API_KEY = "sk-test";
    const supabase = supabaseWithSetting({ data: { provider: "openai" }, error: null });
    expect(await resolveExtractionEngine(supabase, TENANT)).toBe("mock");
  });

  it("uses the preferred provider when its key is configured", async () => {
    process.env.MOCK_AI = "false";
    process.env.AI_MOCK = "false";
    process.env.GEMINI_API_KEY = "g-test";
    delete process.env.OPENAI_API_KEY;
    const supabase = supabaseWithSetting({ data: { provider: "gemini" }, error: null });
    expect(await resolveExtractionEngine(supabase, TENANT)).toBe("gemini");
  });

  it("falls back to the other provider when the preferred key is missing", async () => {
    process.env.MOCK_AI = "false";
    process.env.AI_MOCK = "false";
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "g-test";
    const supabase = supabaseWithSetting({ data: { provider: "openai" }, error: null });
    expect(await resolveExtractionEngine(supabase, TENANT)).toBe("gemini");
  });

  it("returns mock when no provider has a key", async () => {
    process.env.MOCK_AI = "false";
    process.env.AI_MOCK = "false";
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const supabase = supabaseWithSetting({ data: null, error: null });
    expect(await resolveExtractionEngine(supabase, TENANT)).toBe("mock");
  });
});
