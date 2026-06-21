import { afterEach, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;

describe("@/lib/db lazy initialization", () => {
  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    vi.resetModules();
  });

  it("allows schema-only imports without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();

    const mod = await import("@/lib/db");

    expect(mod.tables).toBeDefined();
    expect(mod.tables.gmailAccounts).toBeDefined();
    expect(() => mod.getDb()).toThrow("DATABASE_URL is not set");
  });
});
