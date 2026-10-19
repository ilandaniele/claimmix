/**
 * `urlDeVueltaDeGmail()` cuelga de `resolveBaseURL()`: el connect y el callback
 * la arman por separado y Google exige que coincidan letra por letra.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { urlDeVueltaDeGmail } from "@/lib/auth/base-url";

const RUTA = "/api/admin/gmail-accounts/callback";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("urlDeVueltaDeGmail", () => {
  it("con NEXT_PUBLIC_SITE_URL, cuelga de ese origen", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com");
    vi.stubEnv("VERCEL_URL", "fake-123.example.com");

    expect(urlDeVueltaDeGmail()).toBe(`https://app.example.com${RUTA}`);
  });

  it("sin NEXT_PUBLIC_SITE_URL, cuelga de VERCEL_URL por https", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_URL", "fake-123.example.com");

    expect(urlDeVueltaDeGmail()).toBe(`https://fake-123.example.com${RUTA}`);
  });

  it("sin ninguna de las dos, cae en localhost:3000", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_URL", "");

    expect(urlDeVueltaDeGmail()).toBe(`http://localhost:3000${RUTA}`);
  });
});
