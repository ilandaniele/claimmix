/**
 * `puedeTomarElControl` — D-F2: sólo con el agente terminado del todo.
 *
 * Tabla de verdad: parte de un caso que SÍ puede, y cada test apaga una sola
 * condición para verla dar false.
 */

import { describe, it, expect } from "vitest";
import { puedeTomarElControl } from "@/core/case/tomar-el-control";
import { RESERVA_DE_EXTRACCION_MS } from "@/core/case/reserva-de-extraccion";

const AHORA = new Date("2026-09-27T12:00:00.000Z");

const CASO_OK = {
  puedeCambiarEstado: true,
  plan: "profesional",
  channel: "whatsapp",
  status: "info_faltante",
  extractionPending: false,
  extractionLeaseAt: null,
  ahora: AHORA,
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

  it("da false con una corrida pendiente", () => {
    expect(puedeTomarElControl({ ...CASO_OK, extractionPending: true })).toBe(false);
  });

  it("da false con la reserva todavía viva", () => {
    const haceUnMinuto = new Date(AHORA.getTime() - 60_000).toISOString();
    expect(puedeTomarElControl({ ...CASO_OK, extractionLeaseAt: haceUnMinuto })).toBe(false);
  });

  it("da true con una reserva ya vencida", () => {
    const vencida = new Date(AHORA.getTime() - RESERVA_DE_EXTRACCION_MS - 1_000).toISOString();
    expect(puedeTomarElControl({ ...CASO_OK, extractionLeaseAt: vencida })).toBe(true);
  });
});
