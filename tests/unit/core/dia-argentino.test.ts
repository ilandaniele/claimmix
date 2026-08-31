/**
 * Qué día es, acá.
 *
 * El servidor corre en UTC y Buenos Aires está tres horas atrás, así que entre
 * las 21 y las 24 hora local `toISOString().slice(0, 10)` ya devuelve el día
 * siguiente. Tres horas por día, todos los días.
 *
 * Lo que se rompía con eso:
 *
 * · Una póliza con `end_date` de HOY figuraba vencida a las 22:10, así que
 *   alguien que chocaba el último día de su cobertura recibía «tu póliza venció
 *   el …» y el caso se derivaba como póliza vencida. Está cubierto.
 * · «recibido el 28» para un mensaje que llegó el 27 a la noche — y esa fecha la
 *   lee el modelo para decidir.
 * · El nombre del CSV exportado.
 */

import { describe, it, expect } from "vitest";

import { diaArgentino, ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";

describe("diaArgentino", () => {
  it("a las 22:10 de acá todavía es HOY, aunque en UTC sea mañana", () => {
    // 2026-08-27 22:10 en Buenos Aires = 2026-08-28 01:10 UTC.
    const cuando = new Date("2026-08-28T01:10:00.000Z");

    expect(cuando.toISOString().slice(0, 10)).toBe("2026-08-28"); // lo que decía antes
    expect(diaArgentino(cuando)).toBe("2026-08-27"); // lo que dice el calendario de acá
  });

  it("y a las 21:00 clavadas, que es donde empieza el corrimiento", () => {
    expect(diaArgentino(new Date("2026-08-28T00:00:00.000Z"))).toBe("2026-08-27");
  });

  it("de día coinciden, que es por lo que nadie lo veía", () => {
    // El defecto sólo aparece tres horas al día. El resto del tiempo las dos
    // formas dan lo mismo, y por eso sobrevivió.
    const mediodia = new Date("2026-08-27T15:00:00.000Z"); // 12:00 acá
    expect(diaArgentino(mediodia)).toBe(mediodia.toISOString().slice(0, 10));
  });

  it("devuelve AAAA-MM-DD, que es como compara la base", () => {
    // Un `toLocaleDateString` con el locale equivocado daría `27/8/2026` y la
    // comparación contra `end_date` pasaría a ser siempre falsa, en silencio.
    expect(diaArgentino(new Date("2026-08-27T15:00:00.000Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });

  it("un dígito solo va con cero adelante", () => {
    // `2026-1-5` ordenaría y compararía mal contra `2026-01-05`.
    expect(diaArgentino(new Date("2026-01-05T15:00:00.000Z"))).toBe("2026-01-05");
  });

  it("cruza el año sin marearse", () => {
    // 2027-01-01 01:30 UTC = 2026-12-31 22:30 acá.
    expect(diaArgentino(new Date("2027-01-01T01:30:00.000Z"))).toBe("2026-12-31");
  });

  it("la zona es la del negocio, escrita una sola vez", () => {
    expect(ZONA_ARGENTINA).toBe("America/Argentina/Buenos_Aires");
  });
});
