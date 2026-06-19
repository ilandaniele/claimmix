/**
 * Unit tests for the per-tenant AI provider resolution (provider.ts).
 *
 * Covers:
 *  - env default (AI_PROVIDER, fallback "gemini")
 *  - tenant_ai_settings row wins over env default
 *  - missing table / query error → env default (defensive)
 *  - resolveExtractionEngine: mock mode, key-based fallback, no-keys → mock
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// ---------- db mock (hoisted so it runs before module imports) ----------
const mockDbChain = vi.hoisted(() => {
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  // Each method returns the chain object so calls can be fluent.
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  // limit is terminal — tests override this per-scenario.
  chain.limit.mockResolvedValue([]);
  return chain;
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbChain.select(...args),
  },
  tables: {
    tenantAiSettings: { tenant_id: "tenant_id", provider: "provider" },
  },
}));

vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
}));

// ---------- module under test ----------
import {
  getDefaultProvider,
  getTenantAiProvider,
  resolveExtractionEngine,
  hasProviderKey,
} from "@/server/ai/provider";

// ---------- env helpers ----------
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
  vi.clearAllMocks();
  // Reset chain defaults after each test.
  mockDbChain.select.mockReturnValue(mockDbChain);
  mockDbChain.from.mockReturnValue(mockDbChain);
  mockDbChain.where.mockReturnValue(mockDbChain);
  mockDbChain.limit.mockResolvedValue([]);
});

const TENANT = "10000000-0000-0000-0000-000000000001";

// ---------- helpers ----------
function setDbResult(rows: { provider: string }[]) {
  mockDbChain.limit.mockResolvedValue(rows);
}

function setDbError() {
  mockDbChain.limit.mockRejectedValue(new Error("relation does not exist"));
}

// ---------- tests ----------
describe("getDefaultProvider", () => {
  it("defaults to gemini when AI_PROVIDER is unset", () => {
    delete process.env.AI_PROVIDER;
    expect(getDefaultProvider()).toBe("gemini");
  });

  it("honors AI_PROVIDER=gemini (case-insensitive)", () => {
    process.env.AI_PROVIDER = "GEMINI";
    expect(getDefaultProvider()).toBe("gemini");
  });

  it("falls back to gemini for invalid values", () => {
    process.env.AI_PROVIDER = "claude";
    expect(getDefaultProvider()).toBe("gemini");
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
    setDbResult([{ provider: "gemini" }]);
    expect(await getTenantAiProvider(TENANT)).toBe("gemini");
  });

  it("falls back to env default when no row exists", async () => {
    process.env.AI_PROVIDER = "gemini";
    setDbResult([]);
    expect(await getTenantAiProvider(TENANT)).toBe("gemini");
  });

  it("falls back to env default on query error (table missing)", async () => {
    delete process.env.AI_PROVIDER;
    setDbError();
    expect(await getTenantAiProvider(TENANT)).toBe("gemini");
  });

  it("never throws even when the db throws synchronously", async () => {
    delete process.env.AI_PROVIDER;
    mockDbChain.select.mockImplementation(() => {
      throw new Error("relation does not exist");
    });
    expect(await getTenantAiProvider(TENANT)).toBe("gemini");
    // Restore for afterEach to work correctly.
    mockDbChain.select.mockReturnValue(mockDbChain);
  });

  it("ignores invalid stored values", async () => {
    delete process.env.AI_PROVIDER;
    setDbResult([{ provider: "llama" }]);
    expect(await getTenantAiProvider(TENANT)).toBe("gemini");
  });
});

describe("resolveExtractionEngine", () => {
  it("returns mock when MOCK_AI=true regardless of keys", async () => {
    process.env.MOCK_AI = "true";
    process.env.OPENAI_API_KEY = "sk-test";
    setDbResult([{ provider: "openai" }]);
    expect(await resolveExtractionEngine(TENANT)).toBe("mock");
  });

  it("uses the preferred provider when its key is configured", async () => {
    process.env.MOCK_AI = "false";
    process.env.AI_MOCK = "false";
    process.env.GEMINI_API_KEY = "g-test";
    delete process.env.OPENAI_API_KEY;
    setDbResult([{ provider: "gemini" }]);
    expect(await resolveExtractionEngine(TENANT)).toBe("gemini");
  });

  it("falls back to the other provider when the preferred key is missing", async () => {
    process.env.MOCK_AI = "false";
    process.env.AI_MOCK = "false";
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "g-test";
    setDbResult([{ provider: "openai" }]);
    expect(await resolveExtractionEngine(TENANT)).toBe("gemini");
  });

  it("uses gemini by default when only the Gemini key is configured", async () => {
    process.env.MOCK_AI = "false";
    process.env.AI_MOCK = "false";
    delete process.env.AI_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "g-test";
    setDbResult([]);
    expect(await resolveExtractionEngine(TENANT)).toBe("gemini");
  });

  it("returns mock when no provider has a key", async () => {
    process.env.MOCK_AI = "false";
    process.env.AI_MOCK = "false";
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    setDbResult([]);
    expect(await resolveExtractionEngine(TENANT)).toBe("mock");
  });
});
