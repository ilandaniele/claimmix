/**
 * La cartera de clientes no es del cliente.
 *
 * Todo lo demás bajo /admin es del asegurador: sus usuarios, sus casos, su
 * factura. La lista de clientes cruza tenants, así que mostrársela a un admin
 * de un asegurador sería contarle quiénes son los otros y cuánto pagan.
 *
 * La guarda son dos condiciones, no una: sesión de admin Y dirección del
 * operador. Y falla cerrada — sin ADMIN_EMAILS configurado no hay operador y no
 * la ve nadie. Una lista de clientes que se abre sola cuando falta una variable
 * es la clase de error que nadie mira hasta que ya pasó.
 *
 * Y una tercera, desde el alta automática: el espacio del operador tiene que ser
 * el de la casa. Cualquiera abre un espacio propio y queda como dueño; con una
 * dirección de ADMIN_EMAILS (porque alguien la agregó para probar) pasaba las
 * otras dos y llegaba a las altas de todos.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ requireAdmin: vi.fn(), casa: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/auth/provision", () => ({ resolveDefaultTenantId: h.casa }));

import { AppError } from "@/lib/errors";
import { isOperatorEmail, operatorEmails, requireOperator } from "@/lib/auth/require-operator";

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

const CASA = "11111111-1111-4111-8111-111111111111";
const DE_UN_CLIENTE = "22222222-2222-4222-8222-222222222222";

function sesion(parcial: { tenant_id?: string; email?: string; emailVerified?: boolean } = {}) {
  return {
    user: { id: "u1", email: parcial.email ?? "operador@example.com", emailVerified: parcial.emailVerified ?? true },
    userRow: { id: "u1", tenant_id: parcial.tenant_id ?? CASA, role: "owner", plan: "piloto" },
  };
}

describe("isOperatorEmail", () => {
  it("sin ADMIN_EMAILS no hay operador", () => {
    delete process.env.ADMIN_EMAILS;
    expect(isOperatorEmail("cualquiera@example.com")).toBe(false);
  });

  it("con ADMIN_EMAILS vacío tampoco", () => {
    process.env.ADMIN_EMAILS = "   ";
    expect(isOperatorEmail("cualquiera@example.com")).toBe(false);
  });

  it("reconoce a quien está en la lista", () => {
    process.env.ADMIN_EMAILS = "operador@example.com";
    expect(isOperatorEmail("operador@example.com")).toBe(true);
  });

  it("no le importan las mayúsculas ni los espacios", () => {
    // Better Auth guarda lo que devuelve el proveedor, y la variable la escribe
    // una persona a mano: las dos puntas se normalizan o esto falla el día que
    // alguien deja un espacio después de la coma.
    process.env.ADMIN_EMAILS = " Operador@Example.com , otro@example.com ";
    expect(isOperatorEmail("operador@example.com")).toBe(true);
    expect(isOperatorEmail(" OTRO@EXAMPLE.COM ")).toBe(true);
  });

  it("rechaza a quien no está, aunque sea admin de su tenant", () => {
    process.env.ADMIN_EMAILS = "operador@example.com";
    expect(isOperatorEmail("admin@aseguradora.com")).toBe(false);
  });

  it("sin dirección, no", () => {
    process.env.ADMIN_EMAILS = "operador@example.com";
    expect(isOperatorEmail(null)).toBe(false);
    expect(isOperatorEmail(undefined)).toBe(false);
    expect(isOperatorEmail("")).toBe(false);
  });

  it("una coincidencia parcial no alcanza", () => {
    // "operador@example.com.ar" no es "operador@example.com", y un `includes`
    // en vez de una comparación exacta los daría por iguales.
    process.env.ADMIN_EMAILS = "operador@example.com";
    expect(isOperatorEmail("operador@example.com.ar")).toBe(false);
    expect(isOperatorEmail("otro.operador@example.com")).toBe(false);
  });
});

describe("operatorEmails", () => {
  it("parte la lista y descarta lo vacío", () => {
    process.env.ADMIN_EMAILS = "uno@example.com,,dos@example.com,";
    expect(operatorEmails()).toEqual(["uno@example.com", "dos@example.com"]);
  });
});

describe("requireOperator", () => {
  beforeEach(() => {
    h.requireAdmin.mockReset();
    h.casa.mockReset();
    h.casa.mockReturnValue(CASA);
    process.env.ADMIN_EMAILS = "operador@example.com";
  });

  it("deja pasar al operador verificado del espacio de la casa", async () => {
    h.requireAdmin.mockResolvedValue(sesion());
    await expect(requireOperator()).resolves.toMatchObject({ userRow: { tenant_id: CASA } });
  });

  it("H4: el dueño de un espacio de prueba con una dirección de ADMIN_EMAILS recibe 403", async () => {
    h.requireAdmin.mockResolvedValue(sesion({ tenant_id: DE_UN_CLIENTE }));
    const error = await requireOperator().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("sin inquilino por defecto configurado no hay casa y falla cerrado", async () => {
    h.casa.mockReturnValue(null);
    h.requireAdmin.mockResolvedValue(sesion());
    await expect(requireOperator()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("un inquilino por defecto vacío tampoco es casa", async () => {
    h.casa.mockReturnValue("  ");
    h.requireAdmin.mockResolvedValue(sesion({ tenant_id: "" }));
    await expect(requireOperator()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("compara el inquilino sin mayúsculas ni espacios", async () => {
    h.casa.mockReturnValue(` ${CASA.toUpperCase()} `);
    h.requireAdmin.mockResolvedValue(sesion());
    await expect(requireOperator()).resolves.toBeDefined();
  });

  it("sigue pidiendo la dirección verificada y de la lista", async () => {
    h.requireAdmin.mockResolvedValue(sesion({ emailVerified: false }));
    await expect(requireOperator()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });

    h.requireAdmin.mockResolvedValue(sesion({ email: "admin@aseguradora.example.com" }));
    await expect(requireOperator()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("sin sesión de admin, lo que diga requireAdmin", async () => {
    h.requireAdmin.mockRejectedValue(new AppError("MISSING_SESSION"));
    await expect(requireOperator()).rejects.toMatchObject({ code: "MISSING_SESSION" });
  });
});
