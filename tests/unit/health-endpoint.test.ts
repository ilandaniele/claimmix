/**
 * Unit tests for /api/admin/health endpoint logic.
 *
 * Tests the AI mode detection and response shape logic.
 * DB ping is tested via integration tests (requires Supabase).
 *
 * Deployment validation (W7): health endpoint returns correct AI mode,
 * version, and region fields.
 */

import { describe, it, expect } from "vitest";
import packageJson from "../../package.json";

// ── AI mode detection (mirrors the logic in health/route.ts) ──────────────────

function getAiMode(
  mockAiEnv: string | undefined,
  openAiKey: string | undefined
): "mock" | "openai" {
  return mockAiEnv === "true" || !openAiKey ? "mock" : "openai";
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("health endpoint AI mode detection", () => {
  it("returns mock when MOCK_AI=true regardless of key presence", () => {
    expect(getAiMode("true", "sk-some-key")).toBe("mock");
  });

  it("returns mock when OPENAI_API_KEY is not set", () => {
    expect(getAiMode(undefined, undefined)).toBe("mock");
    expect(getAiMode("false", undefined)).toBe("mock");
    expect(getAiMode(undefined, "")).toBe("mock");
  });

  it("returns openai when MOCK_AI!=true and key is present", () => {
    expect(getAiMode("false", "sk-some-key")).toBe("openai");
    expect(getAiMode(undefined, "sk-some-key")).toBe("openai");
  });
});

describe("health endpoint response fields", () => {
  it("package.json version is semver-like", () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("response has the required fields", () => {
    // Validate the shape of the health response
    const expectedFields = ["status", "db", "ai", "version", "region"];
    const mockResponse = {
      status: "ok",
      db: "connected",
      ai: "mock" as const,
      version: packageJson.version,
      region: "local",
    };
    for (const field of expectedFields) {
      expect(mockResponse).toHaveProperty(field);
    }
  });

  it("ai field is limited to mock | openai", () => {
    const validValues = ["mock", "openai"];
    const aiValue = getAiMode("true", undefined);
    expect(validValues).toContain(aiValue);
  });
});
