/**
 * `derivar`: la marca que sólo este servidor sabe armar para un dato. La usa la ruta
 * secreta del webhook de la app de un cliente (`wa-verify-app`), que no se guarda
 * y se recalcula cada vez. Lo que importa: que sea estable, que dependa del uso y
 * del dato, y que sin BETTER_AUTH_SECRET no salga una marca vacía sino un error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, hkdfSync } from "node:crypto";

vi.mock("server-only", () => ({}));

import { derivar, sellar, abrir } from "@/server/alta/sellado";

const SAVED = { ...process.env };
const SECRETO = "fake-better-auth-secret-0123456789abcdef";

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = SECRETO;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("derivar", () => {
  it("es el HMAC-SHA256 del dato con la clave HKDF del info, en base64url", () => {
    const clave = Buffer.from(hkdfSync("sha256", SECRETO, "claimmix", "wa-verify-app", 32));
    const esperada = createHmac("sha256", clave).update("tenant-1:1234567890123", "utf8").digest("base64url");

    expect(derivar("wa-verify-app", "tenant-1:1234567890123")).toBe(esperada);
  });

  it("es determinista: el mismo info y el mismo dato dan la misma marca", () => {
    expect(derivar("wa-verify-app", "dato")).toBe(derivar("wa-verify-app", "dato"));
  });

  it("cambia con el dato", () => {
    expect(derivar("wa-verify-app", "tenant-1")).not.toBe(derivar("wa-verify-app", "tenant-2"));
    expect(derivar("wa-verify-app", "tenant-1")).not.toBe(derivar("wa-verify-app", "tenant-1 "));
  });

  it("cambia con el info: una marca hecha para un uso no vale en otro", () => {
    expect(derivar("wa-verify-app", "dato")).not.toBe(derivar("wa-verify-otro", "dato"));
    expect(derivar("wa-verify-app", "dato")).not.toBe(derivar("alta-correo", "dato"));
  });

  it("cambia con BETTER_AUTH_SECRET: rotarlo invalida las marcas viejas", () => {
    const antes = derivar("wa-verify-app", "dato");
    process.env.BETTER_AUTH_SECRET = "fake-otro-better-auth-secret-0123456789";

    expect(derivar("wa-verify-app", "dato")).not.toBe(antes);
  });

  it("es base64url de 43 caracteres, apta para una ruta", () => {
    expect(derivar("wa-verify-app", "dato")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("acepta el dato vacío y no mezcla info con dato", () => {
    expect(derivar("wa-verify-app", "")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(derivar("wa-verify-app", "x")).not.toBe(derivar("wa-verify-", "app" + "x"));
  });

  it("sin BETTER_AUTH_SECRET lanza, y con el secreto en blanco también", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => derivar("wa-verify-app", "dato")).toThrow("BETTER_AUTH_SECRET");

    process.env.BETTER_AUTH_SECRET = "   ";
    expect(() => derivar("wa-verify-app", "dato")).toThrow("BETTER_AUTH_SECRET");
  });

  it("no toca lo que ya sellaba: sellar y abrir siguen yendo y viniendo", () => {
    expect(abrir("alta-correo", sellar("alta-correo", { a: 1 }))).toEqual({ a: 1 });
  });
});
