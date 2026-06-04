/**
 * Unit tests for getWorkerBaseUrl() — AC7.
 *
 * Tests all three URL resolution fallbacks:
 *   1. VERCEL_URL set → "https://<value>" (no trailing slash)
 *   2. NEXT_PUBLIC_SITE_URL set (VERCEL_URL absent) → value as-is (trailing slash stripped)
 *   3. Neither set → "http://localhost:3000"
 *
 * Env vars are patched per-test and always restored via afterEach.
 */

import { describe, it, expect, afterEach } from "vitest";

// We import the module fresh each test via a re-import pattern because env is
// read at call-time (not module-init), so a single import is sufficient.
import { getWorkerBaseUrl } from "@/server/email/dispatch-url";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Snapshot of original env vars so we can restore after each test. */
const ORIGINAL_VERCEL_URL = process.env.VERCEL_URL;
const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  // Restore env to original state after each test.
  if (ORIGINAL_VERCEL_URL === undefined) {
    delete process.env.VERCEL_URL;
  } else {
    process.env.VERCEL_URL = ORIGINAL_VERCEL_URL;
  }

  if (ORIGINAL_SITE_URL === undefined) {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  } else {
    process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getWorkerBaseUrl", () => {
  describe("VERCEL_URL priority (AC7 — first fallback)", () => {
    it("returns https://<VERCEL_URL> when VERCEL_URL is set", () => {
      process.env.VERCEL_URL = "my-project-abc123.vercel.app";
      delete process.env.NEXT_PUBLIC_SITE_URL;

      expect(getWorkerBaseUrl()).toBe("https://my-project-abc123.vercel.app");
    });

    it("trims whitespace from VERCEL_URL", () => {
      process.env.VERCEL_URL = "  my-project.vercel.app  ";
      delete process.env.NEXT_PUBLIC_SITE_URL;

      expect(getWorkerBaseUrl()).toBe("https://my-project.vercel.app");
    });

    it("prefers VERCEL_URL over NEXT_PUBLIC_SITE_URL when both are set", () => {
      process.env.VERCEL_URL = "my-project.vercel.app";
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";

      expect(getWorkerBaseUrl()).toBe("https://my-project.vercel.app");
    });

    it("ignores VERCEL_URL when it is an empty string", () => {
      process.env.VERCEL_URL = "";
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("ignores VERCEL_URL when it is whitespace only", () => {
      process.env.VERCEL_URL = "   ";
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });
  });

  describe("NEXT_PUBLIC_SITE_URL fallback (AC7 — second fallback)", () => {
    it("returns NEXT_PUBLIC_SITE_URL when VERCEL_URL is absent", () => {
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("strips trailing slash from NEXT_PUBLIC_SITE_URL", () => {
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com/";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("handles http:// site URL (local / staging without TLS)", () => {
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });

    it("trims whitespace from NEXT_PUBLIC_SITE_URL", () => {
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "  https://claimmix.com  ";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("ignores NEXT_PUBLIC_SITE_URL when it is an empty string", () => {
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "";

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });
  });

  describe("localhost fallback (AC7 — third fallback)", () => {
    it("returns http://localhost:3000 when neither env var is set", () => {
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });

    it("returns http://localhost:3000 when both env vars are empty strings", () => {
      process.env.VERCEL_URL = "";
      process.env.NEXT_PUBLIC_SITE_URL = "";

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });
  });

  describe("URL shape invariants", () => {
    it("returned URL never has a trailing slash (VERCEL_URL path)", () => {
      process.env.VERCEL_URL = "my-project.vercel.app";
      delete process.env.NEXT_PUBLIC_SITE_URL;

      const url = getWorkerBaseUrl();
      expect(url.endsWith("/")).toBe(false);
    });

    it("returned URL never has a trailing slash (NEXT_PUBLIC_SITE_URL path)", () => {
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com/";

      const url = getWorkerBaseUrl();
      expect(url.endsWith("/")).toBe(false);
    });

    it("appending /api/worker/extract produces a valid URL for fetch", () => {
      process.env.VERCEL_URL = "my-project.vercel.app";
      delete process.env.NEXT_PUBLIC_SITE_URL;

      const base = getWorkerBaseUrl();
      const full = `${base}/api/worker/extract`;
      expect(() => new URL(full)).not.toThrow();
      expect(full).toBe("https://my-project.vercel.app/api/worker/extract");
    });
  });
});
