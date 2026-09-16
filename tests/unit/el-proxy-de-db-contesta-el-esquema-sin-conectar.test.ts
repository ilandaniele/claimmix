import { afterEach, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;

describe("@/lib/db proxy responde `_` sin conectar", () => {
  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    vi.resetModules();
  });

  it("expone los metadatos del esquema aunque no haya DATABASE_URL, y sigue fallando al conectar", async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();

    const mod = await import("@/lib/db");

    expect(() => mod.db._).not.toThrow();
    expect(mod.db._.fullSchema).toBeTypeOf("object");
    expect(mod.db._.schema).toBeTypeOf("object");
    expect(mod.db._.tableNamesMap).toBeTypeOf("object");
    expect(mod.db._.fullSchema.cases).toBeDefined();

    // El adapter de Drizzle de Better Auth lee esto al construirse (module load):
    // tiene que estar sin conectar, o revienta el build igual que con #169.
    expect(mod.db._.schema?.accounts).toBeDefined();

    // Todo lo que no sea `_` sigue conectando recién al consultar.
    expect(() => mod.db.select).toThrow("DATABASE_URL is not set");
  });
});
