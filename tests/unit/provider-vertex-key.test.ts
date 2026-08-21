/**
 * Vertex does not use an API key, and asking for one answered the wrong
 * question in the worst possible way.
 *
 * The resolver's rule reads sensibly: use the preferred provider if its key is
 * configured, otherwise the other one, otherwise the mock — so the pipeline
 * degrades instead of crashing. But "is Gemini available" was implemented as
 * "is there a GEMINI_API_KEY", and under the Vertex transport there is no API
 * key by design; authentication is a service account.
 *
 * So a deployment with working Vertex credentials and no leftover API key
 * resolved all the way down to the mock extractor. Silently. It happened in a
 * CI run: twelve conversations were rehearsed against canned data and reported
 * as the agent's behaviour, and the failures they produced sent me looking for
 * a bug that did not exist.
 *
 * Production was one unused environment variable away from the same thing —
 * an insurer's claimants receiving mock output, with nothing in the logs
 * saying so.
 */

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  },
  tables: {
    tenantAiSettings: {
      provider: "provider",
      gemini_api_key_encrypted: "gemini_api_key_encrypted",
      tenant_id: "tenant_id",
    },
  },
}));

vi.mock("@/lib/db/helpers", () => ({
  firstRow: (rows: unknown[]) => rows[0] ?? null,
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hasProviderKeyForTenant,
  isVertexConfigured,
  resolveExtractionEngine,
} from "@/server/ai/provider";

const TENANT = "10000000-0000-0000-0000-000000000001";

const SAVED = { ...process.env };

beforeEach(() => {
  for (const key of [
    "GEMINI_TRANSPORT",
    "GOOGLE_CLOUD_PROJECT",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "AI_PROVIDER",
    "MOCK_AI",
    "AI_MOCK",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("isVertexConfigured", () => {
  it("is on when the transport is vertex and a project is named", () => {
    process.env.GEMINI_TRANSPORT = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = "claimmix-prod";
    expect(isVertexConfigured()).toBe(true);
  });

  it("is off without a project — the transport alone reaches nothing", () => {
    process.env.GEMINI_TRANSPORT = "vertex";
    expect(isVertexConfigured()).toBe(false);
  });

  it("is off under the AI Studio transport", () => {
    process.env.GEMINI_TRANSPORT = "ai-studio";
    process.env.GOOGLE_CLOUD_PROJECT = "claimmix-prod";
    expect(isVertexConfigured()).toBe(false);
  });
});

describe("hasProviderKeyForTenant — Gemini over Vertex", () => {
  it("counts Vertex as available with no API key at all", () => {
    // The fix. Before this, the answer here was false and everything
    // downstream quietly chose the mock.
    process.env.GEMINI_TRANSPORT = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = "claimmix-prod";

    return expect(hasProviderKeyForTenant(TENANT, "gemini")).resolves.toBe(true);
  });

  it("still wants a key when Vertex is not configured", async () => {
    expect(await hasProviderKeyForTenant(TENANT, "gemini")).toBe(false);

    process.env.GEMINI_API_KEY = "una-clave";
    expect(await hasProviderKeyForTenant(TENANT, "gemini")).toBe(true);
  });
});

describe("resolveExtractionEngine — never silently mock", () => {
  it("picks gemini from Vertex credentials alone", async () => {
    process.env.GEMINI_TRANSPORT = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = "claimmix-prod";

    expect(await resolveExtractionEngine(TENANT)).toBe("gemini");
  });

  it("falls to mock only when there is genuinely no model to call", async () => {
    // Still the right behaviour when nothing is configured: degrade rather
    // than crash. The bug was reaching it with a perfectly good Vertex setup.
    expect(await resolveExtractionEngine(TENANT)).toBe("mock");
  });

  it("obeys MOCK_AI, which is someone asking for it on purpose", async () => {
    process.env.GEMINI_TRANSPORT = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = "claimmix-prod";
    process.env.MOCK_AI = "true";

    expect(await resolveExtractionEngine(TENANT)).toBe("mock");
  });
});
