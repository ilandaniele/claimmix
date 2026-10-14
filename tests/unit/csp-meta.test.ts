import { afterEach, describe, expect, it } from "vitest";

import { buildCsp } from "@/lib/security/csp";

const NONCE = "nonce-de-prueba";
const ENV = { ...process.env };

function directivas(csp: string): Record<string, string> {
  return Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d]));
}

afterEach(() => {
  process.env = { ...ENV };
});

describe("la CSP de /conectar-whatsapp", () => {
  it("sin `meta` es idéntica a la de siempre, con o sin segundo argumento", () => {
    expect(buildCsp(NONCE, { meta: false })).toBe(buildCsp(NONCE));
    expect(buildCsp(NONCE, {})).toBe(buildCsp(NONCE));
    expect(buildCsp(NONCE)).not.toContain("facebook");
  });

  it("con `meta` suma sólo los orígenes de Facebook, en script, connect y frame", () => {
    const base = directivas(buildCsp(NONCE));
    const meta = directivas(buildCsp(NONCE, { meta: true }));

    expect(meta["script-src"]).toBe(`${base["script-src"]} https://connect.facebook.net`);
    expect(meta["connect-src"]).toBe(
      `${base["connect-src"]} https://www.facebook.com https://graph.facebook.com https://connect.facebook.net`,
    );
    expect(meta["frame-src"]).toBe(
      `${base["frame-src"]} https://www.facebook.com https://web.facebook.com https://business.facebook.com https://staticxx.facebook.com`,
    );
  });

  it("las demás directivas no cambian", () => {
    const base = directivas(buildCsp(NONCE));
    const meta = directivas(buildCsp(NONCE, { meta: true }));
    for (const nombre of Object.keys(base)) {
      if (["script-src", "connect-src", "frame-src"].includes(nombre)) continue;
      expect(meta[nombre]).toBe(base[nombre]);
    }
    expect(Object.keys(meta)).toEqual(Object.keys(base));
  });

  it("sigue sin `unsafe-inline` ni `unsafe-eval` en los scripts, y sin un comodín de Facebook", () => {
    const csp = buildCsp(NONCE, { meta: true });

    expect(directivas(csp)["script-src"]).not.toMatch(/unsafe-(inline|eval)/);
    expect(csp).not.toContain("*.facebook.com");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("convive con el origen de Turnstile sin duplicarlo", () => {
    process.env.TURNSTILE_SITE_KEY = "test-turnstile-key";
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-key";
    const csp = buildCsp(NONCE, { meta: true });

    expect(csp.split("https://challenges.cloudflare.com")).toHaveLength(3);
    expect(directivas(csp)["script-src"]).toContain("https://connect.facebook.net");
  });
});
