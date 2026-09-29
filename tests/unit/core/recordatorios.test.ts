/**
 * Cuándo toca recordar lo que falta (B4), sin red ni base.
 */

import { describe, expect, it } from "vitest";
import { etapaVencida, horasDeRecordatorio, pedidoReciente } from "@/core/case/recordatorios";

const ANCLA = "2026-09-01T12:00:00.000Z";
const a = (horas: number) => new Date(new Date(ANCLA).getTime() + horas * 60 * 60 * 1000);

describe("etapaVencida", () => {
  it.each([
    [47, null],
    [48, 1],
    [119, 1],
    [120, 2],
    [500, 2],
  ])("a las %s h da %s", (horas, etapa) => {
    expect(etapaVencida([48, 120], ANCLA, a(horas))).toBe(etapa);
  });

  it("sin horas no vence nada", () => {
    expect(etapaVencida([], ANCLA, a(1000))).toBeNull();
  });
});

describe("zod de horas", () => {
  it.each([[[]], [[48]], [[48, 120]], [[24, 48]]])("acepta %j", (horas) => {
    expect(horasDeRecordatorio.safeParse(horas).success).toBe(true);
  });

  it.each([
    ["más de dos", [48, 120, 240]],
    ["menos de 24", [12]],
    ["más de 720", [721]],
    ["no ascendente", [120, 48]],
    ["hueco menor a 24", [48, 60]],
    ["no entero", [48.5]],
    ["no número", ["48"]],
  ])("rechaza %s", (_nombre, horas) => {
    expect(horasDeRecordatorio.safeParse(horas).success).toBe(false);
  });
});

describe("pedidoReciente", () => {
  it("menos de 24 h es reciente", () => {
    expect(pedidoReciente(ANCLA, a(23))).toBe(true);
  });

  it("24 h o más ya no", () => {
    expect(pedidoReciente(ANCLA, a(24))).toBe(false);
  });

  it("sin pedido no es reciente", () => {
    expect(pedidoReciente(null, a(1))).toBe(false);
  });
});
