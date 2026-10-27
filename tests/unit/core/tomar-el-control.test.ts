/**
 * `puedeTomarElControl` — se puede en cualquier momento, aunque el agente esté
 * trabajando; `puedeDevolverAlAgente` — D-F2: sólo con el agente terminado.
 *
 * Tabla de verdad: parte de un caso que SÍ puede, y cada test apaga una sola
 * condición para verla dar false.
 */

import { describe, it, expect } from "vitest";
import { puedeTomarElControl, puedeDevolverAlAgente } from "@/core/case/tomar-el-control";

const AHORA = new Date("2026-09-27T12:00:00.000Z");

const CASO_OK = {
  puedeCambiarEstado: true,
  plan: "profesional",
  channel: "whatsapp",
  status: "info_faltante",
};

describe("puedeTomarElControl", () => {
  it("da true cuando todas las condiciones se cumplen", () => {
    expect(puedeTomarElControl(CASO_OK)).toBe(true);
  });

  it("da false sin permiso para cambiar el estado", () => {
    expect(puedeTomarElControl({ ...CASO_OK, puedeCambiarEstado: false })).toBe(false);
  });

  it("da false por mail (no es un canal de WhatsApp)", () => {
    expect(puedeTomarElControl({ ...CASO_OK, channel: "email" })).toBe(false);
  });

  it("acepta whatsapp_sim, igual que whatsapp", () => {
    expect(puedeTomarElControl({ ...CASO_OK, channel: "whatsapp_sim" })).toBe(true);
  });

  it("da false con un plan que no es Pro", () => {
    expect(puedeTomarElControl({ ...CASO_OK, plan: "piloto" })).toBe(false);
  });

  it("da false con plan null", () => {
    expect(puedeTomarElControl({ ...CASO_OK, plan: null })).toBe(false);
  });

  it("da false fuera de info_faltante / confirmacion_pendiente", () => {
    expect(puedeTomarElControl({ ...CASO_OK, status: "escalado" })).toBe(false);
  });

  it("acepta confirmacion_pendiente, igual que info_faltante", () => {
    expect(puedeTomarElControl({ ...CASO_OK, status: "confirmacion_pendiente" })).toBe(true);
  });

  it("da false en requiere_especialista (ya lo tomó alguien)", () => {
    expect(puedeTomarElControl({ ...CASO_OK, status: "requiere_especialista" })).toBe(false);
  });
});

describe("puedeDevolverAlAgente", () => {
  const CASO_DEVOLVIBLE = {
    puedeCambiarEstado: true,
    plan: "profesional",
    channel: "whatsapp",
    status: "requiere_especialista",
    extractionPending: false,
    extractionLeaseAt: null,
    devolvible: true,
    ahora: AHORA,
  };

  it("da true cuando todas las condiciones se cumplen", () => {
    expect(puedeDevolverAlAgente(CASO_DEVOLVIBLE)).toBe(true);
  });

  it("da false sin permiso para cambiar el estado", () => {
    expect(puedeDevolverAlAgente({ ...CASO_DEVOLVIBLE, puedeCambiarEstado: false })).toBe(false);
  });

  it("da false por mail (no es un canal de WhatsApp)", () => {
    expect(puedeDevolverAlAgente({ ...CASO_DEVOLVIBLE, channel: "email" })).toBe(false);
  });

  it("da false con un plan que no es Pro", () => {
    expect(puedeDevolverAlAgente({ ...CASO_DEVOLVIBLE, plan: "piloto" })).toBe(false);
  });

  it("da false fuera de requiere_especialista", () => {
    expect(puedeDevolverAlAgente({ ...CASO_DEVOLVIBLE, status: "info_faltante" })).toBe(false);
  });

  it("da false con una corrida pendiente", () => {
    expect(puedeDevolverAlAgente({ ...CASO_DEVOLVIBLE, extractionPending: true })).toBe(false);
  });

  it("da false con la reserva todavía viva", () => {
    const haceUnMinuto = new Date(AHORA.getTime() - 60_000).toISOString();
    expect(puedeDevolverAlAgente({ ...CASO_DEVOLVIBLE, extractionLeaseAt: haceUnMinuto })).toBe(false);
  });

  it("da false si el último movimiento no fue tomar el control", () => {
    expect(puedeDevolverAlAgente({ ...CASO_DEVOLVIBLE, devolvible: false })).toBe(false);
  });
});
