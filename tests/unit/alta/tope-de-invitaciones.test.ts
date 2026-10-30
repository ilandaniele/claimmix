/**
 * El tope de invitaciones del día: lo comparten la ruta que invita (tope del cupo) y
 * la pantalla de usuarios (cuántas filas deja armar el diálogo en lote).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { topeDeInvitacionesDelDia } from "@/server/alta/tope-de-invitaciones";

const PRUEBA = { billing_status: "trial", autoalta: true };
const PAGO = { billing_status: "active", autoalta: false };

afterEach(() => vi.unstubAllEnvs());

describe("topeDeInvitacionesDelDia", () => {
  it("fuera de la prueba rige ALTA_TOPE_INVITACIONES_DIA, 20 por omisión", () => {
    expect(topeDeInvitacionesDelDia(PAGO)).toBe(20);

    vi.stubEnv("ALTA_TOPE_INVITACIONES_DIA", "7");
    expect(topeDeInvitacionesDelDia(PAGO)).toBe(7);
  });

  it("una prueba gratuita invita a lo sumo a cinco, aunque la variable permita más", () => {
    expect(topeDeInvitacionesDelDia(PRUEBA)).toBe(5);

    vi.stubEnv("ALTA_TOPE_INVITACIONES_DIA", "50");
    expect(topeDeInvitacionesDelDia(PRUEBA)).toBe(5);
  });

  it("una prueba nunca pasa el tope del ambiente: si éste es menor que cinco, rige el menor", () => {
    vi.stubEnv("ALTA_TOPE_INVITACIONES_DIA", "2");

    expect(topeDeInvitacionesDelDia(PRUEBA)).toBe(2);
  });

  it("una variable que no es un entero válido toma la omisión", () => {
    vi.stubEnv("ALTA_TOPE_INVITACIONES_DIA", "mil");
    expect(topeDeInvitacionesDelDia(PAGO)).toBe(20);

    vi.stubEnv("ALTA_TOPE_INVITACIONES_DIA", "0");
    expect(topeDeInvitacionesDelDia(PAGO)).toBe(20);
  });

  it.each([
    ["autoalta sin estado de prueba", { billing_status: "active", autoalta: true }],
    ["en prueba pero sin autoalta", { billing_status: "trial", autoalta: false }],
    ["sin datos de facturación", {}],
    ["autoalta nula", { billing_status: "trial", autoalta: null }],
  ])("no es prueba: %s", (_cual, inquilino) => {
    expect(topeDeInvitacionesDelDia(inquilino)).toBe(20);
  });
});
