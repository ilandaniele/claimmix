/**
 * El primer instante del mes, con la hora del servidor: desde ahí se suma el gasto mensual y se fecha
 * el aviso de cada tope.
 */

import { describe, expect, it } from "vitest";

import { inicioDelMes } from "@/core/fecha/inicio-del-mes";

describe("inicioDelMes", () => {
  it("es el primer instante del mes de la fecha, a las 00:00", () => {
    const inicio = inicioDelMes(new Date(2026, 9, 24, 15, 30, 45, 123));

    expect(inicio.getFullYear()).toBe(2026);
    expect(inicio.getMonth()).toBe(9);
    expect([inicio.getDate(), inicio.getHours(), inicio.getMinutes(), inicio.getSeconds(), inicio.getMilliseconds()]).toEqual([1, 0, 0, 0, 0]);
  });

  it("no toca la fecha que recibe", () => {
    const ahora = new Date(2026, 9, 24, 15, 30);

    inicioDelMes(ahora);

    expect(ahora.getDate()).toBe(24);
    expect(ahora.getHours()).toBe(15);
  });

  it("sin argumento usa el mes en curso", () => {
    const inicio = inicioDelMes();
    const hoy = new Date();

    expect([inicio.getFullYear(), inicio.getMonth(), inicio.getDate()]).toEqual([hoy.getFullYear(), hoy.getMonth(), 1]);
  });
});
