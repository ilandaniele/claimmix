/**
 * Unit tests for getWorkerBaseUrl() — AC7.
 *
 * Tests all four URL resolution fallbacks:
 *   1. NEXT_PUBLIC_APP_URL set → value as-is (trailing slash stripped)
 *   2. NEXT_PUBLIC_SITE_URL set → value as-is (trailing slash stripped)
 *   3. VERCEL_URL set → "https://<value>" (no trailing slash)
 *   4. None set → "http://localhost:3000"
 *
 * The public app/site URLs take precedence over VERCEL_URL because the
 * per-deployment generated URL is covered by Vercel Deployment Protection
 * (SSO) — server-side fetches to it receive a 401 challenge page.
 *
 * Env vars are patched per-test and always restored via afterEach.
 */

import { describe, it, expect, afterEach } from "vitest";

// We import the module fresh each test via a re-import pattern because env is
// read at call-time (not module-init), so a single import is sufficient.
import { getWorkerBaseUrl } from "@/server/email/dispatch-url";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Snapshot of original env vars so we can restore after each test. */
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ORIGINAL_VERCEL_URL = process.env.VERCEL_URL;
const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restore("NEXT_PUBLIC_APP_URL", ORIGINAL_APP_URL);
  restore("VERCEL_URL", ORIGINAL_VERCEL_URL);
  restore("NEXT_PUBLIC_SITE_URL", ORIGINAL_SITE_URL);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getWorkerBaseUrl", () => {
  describe("NEXT_PUBLIC_APP_URL priority (first fallback)", () => {
    it("returns NEXT_PUBLIC_APP_URL when set", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://claimmix.vercel.app";
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;

      expect(getWorkerBaseUrl()).toBe("https://claimmix.vercel.app");
    });

    it("prefers NEXT_PUBLIC_APP_URL over VERCEL_URL and NEXT_PUBLIC_SITE_URL", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://claimmix.vercel.app";
      process.env.VERCEL_URL = "my-project-abc123.vercel.app";
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.vercel.app");
    });

    it("strips trailing slash and trims whitespace", () => {
      process.env.NEXT_PUBLIC_APP_URL = "  https://claimmix.vercel.app/  ";
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;

      expect(getWorkerBaseUrl()).toBe("https://claimmix.vercel.app");
    });

    it("ignores NEXT_PUBLIC_APP_URL when it is an empty string", () => {
      process.env.NEXT_PUBLIC_APP_URL = "";
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";
      delete process.env.VERCEL_URL;

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });
  });

  describe("NEXT_PUBLIC_SITE_URL fallback (second fallback)", () => {
    it("returns NEXT_PUBLIC_SITE_URL when NEXT_PUBLIC_APP_URL is absent", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("prefers NEXT_PUBLIC_SITE_URL over VERCEL_URL (SSO-protected deployment URL)", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      process.env.VERCEL_URL = "my-project.vercel.app";
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("strips trailing slash from NEXT_PUBLIC_SITE_URL", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.com/";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("handles http:// site URL (local / staging without TLS)", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });

    it("trims whitespace from NEXT_PUBLIC_SITE_URL", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "  https://claimmix.com  ";

      expect(getWorkerBaseUrl()).toBe("https://claimmix.com");
    });

    it("ignores NEXT_PUBLIC_SITE_URL when it is an empty string", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.VERCEL_URL;
      process.env.NEXT_PUBLIC_SITE_URL = "";

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });
  });

  describe("VERCEL_URL fallback (third fallback)", () => {
    it("returns https://<VERCEL_URL> when no public URL is set", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.VERCEL_URL = "my-project-abc123.vercel.app";

      expect(getWorkerBaseUrl()).toBe("https://my-project-abc123.vercel.app");
    });

    it("trims whitespace from VERCEL_URL", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.VERCEL_URL = "  my-project.vercel.app  ";

      expect(getWorkerBaseUrl()).toBe("https://my-project.vercel.app");
    });

    it("ignores VERCEL_URL when it is whitespace only", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.VERCEL_URL = "   ";

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });
  });

  describe("localhost fallback (last fallback)", () => {
    it("returns http://localhost:3000 when no env var is set", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });

    it("returns http://localhost:3000 when all env vars are empty strings", () => {
      process.env.NEXT_PUBLIC_APP_URL = "";
      process.env.VERCEL_URL = "";
      process.env.NEXT_PUBLIC_SITE_URL = "";

      expect(getWorkerBaseUrl()).toBe("http://localhost:3000");
    });
  });

  describe("URL shape invariants", () => {
    it("returned URL never has a trailing slash (VERCEL_URL path)", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.VERCEL_URL = "my-project.vercel.app";

      const url = getWorkerBaseUrl();
      expect(url.endsWith("/")).toBe(false);
    });

    it("returned URL never has a trailing slash (NEXT_PUBLIC_APP_URL path)", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://claimmix.vercel.app/";
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;

      const url = getWorkerBaseUrl();
      expect(url.endsWith("/")).toBe(false);
    });

    it("appending /api/worker/extract produces a valid URL for fetch", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://claimmix.vercel.app";
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;

      const base = getWorkerBaseUrl();
      const full = `${base}/api/worker/extract`;
      expect(() => new URL(full)).not.toThrow();
      expect(full).toBe("https://claimmix.vercel.app/api/worker/extract");
    });
  });
});
