/**
 * G25(e) — antes de unificar el parseo de ADMIN_EMAILS en un solo
 * `listaDeCorreos`, hay que probar que los tres sitios de hoy dan el mismo
 * resultado. Es una ruta de autorización: si discrepan en algo, no se
 * unifica.
 *
 * Los tres parten la variable con el mismo patrón
 * (`split(",").map(trim+lower).filter(Boolean)`):
 *   - require-operator.ts `operatorEmails()`
 *   - provision.ts `isAllowlistedAdmin()` (privada; se observa por el rol que
 *     asigna `provisionUserProfile`)
 *   - registro-permitido.ts `parsearPermitidos()`, que además distingue
 *     "@dominio" de una dirección y por eso hace un filtro extra.
 *
 * Para los seis casos pedidos (espacios, mayúsculas, entradas vacías, coma
 * final, undefined, string vacío) los tres coinciden. El último bloque agrega
 * una entrada "@" sola, que expone la diferencia real: `parsearPermitidos` la
 * trata como un dominio con nombre vacío y la descarta con su filtro extra;
 * `operatorEmails` y el parseo interno de `isAllowlistedAdmin` (idéntico por
 * lectura directa de provision.ts:38-44) la conservan. Por eso NO se unifican:
 * quedan las tres implementaciones como están.
 */

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  tables: {},
}));

vi.mock("server-only", () => ({}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { operatorEmails } from "@/lib/auth/require-operator";
import { parsearPermitidos } from "@/lib/auth/registro-permitido";
import { provisionUserProfile } from "@/lib/auth/provision";
import { db } from "@/lib/db";

const TENANT = "10000000-0000-0000-0000-000000000001";

/** Los seis casos que pide G25(e), con el resultado de hoy para una dirección normal. */
const CASOS_COMUNES: Array<[string, string | undefined, string[]]> = [
  ["con espacios", "  ana@x.com  ,  beto@x.com  ", ["ana@x.com", "beto@x.com"]],
  ["mayúsculas", "ANA@X.COM", ["ana@x.com"]],
  ["entradas vacías", "ana@x.com,,beto@x.com", ["ana@x.com", "beto@x.com"]],
  ["coma final", "ana@x.com,", ["ana@x.com"]],
  ["undefined", undefined, []],
  ["string vacío", "", []],
];

describe("operatorEmails y parsearPermitidos coinciden en los seis casos", () => {
  const ORIGINAL = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL;
  });

  it.each(CASOS_COMUNES)("%s", (_nombre, raw, esperado) => {
    if (raw === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = raw;

    expect(operatorEmails()).toEqual(esperado);
    expect(parsearPermitidos(raw).map((p) => p.valor)).toEqual(esperado);
  });
});

describe("provision.ts coincide con las otras dos en los seis casos", () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_DEFAULT_TENANT_ID = TENANT;
    // Pasa el portón de alta (isSignupAllowed) para cualquier ADMIN_EMAILS de
    // la tabla: lo que se compara acá es sólo la lista de admins.
    process.env.SIGNUP_ALLOWED_EMAILS = "@x.com";
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it.each(CASOS_COMUNES)("%s: el rol de ana@x.com coincide con la lista", async (_nombre, raw, esperado) => {
    if (raw === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = raw;

    const values = vi.fn().mockResolvedValue(undefined);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values });

    await provisionUserProfile({ id: "u", name: "Ana", email: "ana@x.com", emailVerified: true });

    const esperaAdmin = esperado.includes("ana@x.com");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ role: esperaAdmin ? "admin" : "analyst" })
    );
  });
});

describe("una entrada '@' sola: acá discrepan, y por eso no se unifican", () => {
  const ORIGINAL = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL;
  });

  it("operatorEmails conserva la entrada literal '@'", () => {
    process.env.ADMIN_EMAILS = "ana@x.com,@,beto@x.com";
    expect(operatorEmails()).toEqual(["ana@x.com", "@", "beto@x.com"]);
  });

  it("parsearPermitidos la trata como dominio vacío y la descarta", () => {
    expect(parsearPermitidos("ana@x.com,@,beto@x.com").map((p) => p.valor)).toEqual([
      "ana@x.com",
      "beto@x.com",
    ]);
  });

  /*
   * provision.ts no se puede ejercitar con la dirección "@": el portón previo
   * (isSignupAllowed) ya la rechaza por forma de dirección antes de llegar a
   * isAllowlistedAdmin. Pero su parseo interno (provision.ts:38-44) es la
   * misma cadena que operatorEmails —split(",").map(trim+lower).filter(Boolean)—,
   * verificado por lectura directa del archivo, así que hereda la misma lista
   * que operatorEmails y discrepa con parsearPermitidos igual que ella.
   */
});
