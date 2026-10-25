/**
 * El primer instante del mes argentino: desde ahí se suma el gasto mensual y se fecha el aviso de cada
 * tope. Las fechas van en UTC para que el test diga lo mismo en Vercel, en una máquina de acá o en Tokio.
 */

import { describe, expect, it } from "vitest";

import { mesArgentino } from "@/core/fecha/dia-argentino";
import { inicioDelMes } from "@/core/fecha/inicio-del-mes";

describe("inicioDelMes", () => {
  it("es la medianoche argentina del primero, las 03:00 en UTC", () => {
    expect(inicioDelMes(new Date("2026-10-24T15:30:45.123Z"))).toEqual(new Date("2026-10-01T03:00:00.000Z"));
  });

  it("a las 23:59 del último día en Argentina sigue siendo el mes que termina, aunque en UTC ya sea el otro", () => {
    expect(inicioDelMes(new Date("2026-11-01T02:59:59Z"))).toEqual(new Date("2026-10-01T03:00:00.000Z"));
    expect(inicioDelMes(new Date("2026-11-01T03:00:00Z"))).toEqual(new Date("2026-11-01T03:00:00.000Z"));
  });

  it("de diciembre a enero cambia el año a la medianoche de acá", () => {
    expect(inicioDelMes(new Date("2027-01-01T02:00:00Z"))).toEqual(new Date("2026-12-01T03:00:00.000Z"));
    expect(inicioDelMes(new Date("2027-01-01T03:00:00Z"))).toEqual(new Date("2027-01-01T03:00:00.000Z"));
  });

  it("no toca la fecha que recibe", () => {
    const ahora = new Date("2026-10-24T15:30:00Z");

    inicioDelMes(ahora);

    expect(ahora.toISOString()).toBe("2026-10-24T15:30:00.000Z");
  });

  it("sin argumento usa el mes argentino en curso", () => {
    const antes = mesArgentino(new Date()).inicio;
    const inicio = inicioDelMes().toISOString();
    const despues = mesArgentino(new Date()).inicio;

    expect([antes, despues]).toContain(inicio);
  });
});
