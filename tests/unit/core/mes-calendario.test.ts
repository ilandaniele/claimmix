/**
 * El mes de un período, escrito para que lo lea una persona.
 *
 * Dos cosas que se rompen solas y no se ven mirando la pantalla:
 *
 * · Formatearlo en horario argentino lo corre al mes ANTERIOR. El primero de
 *   septiembre a la medianoche UTC son las 21 del 31 de agosto en Buenos Aires,
 *   así que un encabezado que dijera «la facturación de septiembre» sobre datos
 *   de septiembre saldría titulado «agosto». Por eso se arma en UTC y se
 *   formatea en UTC — es la única de las funciones de fecha del producto que NO
 *   mira a Buenos Aires, y es a propósito.
 * · El idioma sí sigue a quien mira. Estaba escrita a mano adentro de
 *   facturación, y la pantalla hermana mostraba «2026-09» crudo.
 */

import { describe, it, expect } from "vitest";

import { mesDeCalendario } from "@/core/fecha/mes-calendario";

describe("mesDeCalendario", () => {
  it("escribe el mes en castellano", () => {
    expect(mesDeCalendario("2026-09", "es-AR")).toBe("septiembre de 2026");
  });

  it("y en inglés, para quien tiene la interfaz en inglés", () => {
    expect(mesDeCalendario("2026-09", "en-US")).toBe("September 2026");
  });

  it("no se corre al mes anterior, que es lo que pasaría formateando en hora argentina", () => {
    // Buenos Aires está tres horas atrás: el arranque de septiembre en UTC es
    // el 31 de agosto a las 21 de acá. Si la zona se heredara, diría agosto.
    for (const mes of ["2026-01", "2026-09", "2026-12"]) {
      const [, m] = mes.split("-");
      const enArgentina = new Date(`${mes}-01T00:00:00.000Z`).toLocaleDateString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        month: "long",
        year: "numeric",
      });
      const esperado = new Date(Date.UTC(2026, Number(m) - 1, 15)).toLocaleDateString("es-AR", {
        timeZone: "UTC",
        month: "long",
        year: "numeric",
      });

      expect(mesDeCalendario(mes, "es-AR")).toBe(esperado);
      expect(mesDeCalendario(mes, "es-AR")).not.toBe(enArgentina);
    }
  });

  it("enero no se cae al diciembre del año anterior", () => {
    expect(mesDeCalendario("2026-01", "es-AR")).toBe("enero de 2026");
  });
});
