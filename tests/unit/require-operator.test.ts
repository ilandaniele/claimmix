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
 */

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isOperatorEmail, operatorEmails } from "@/lib/auth/require-operator";

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

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
