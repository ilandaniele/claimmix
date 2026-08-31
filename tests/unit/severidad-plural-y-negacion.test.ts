/**
 * La capa de patrones tenía que ver el plural, y no lo veía.
 *
 * «herido» no matcheaba «heridos», y eso estaba escrito en el archivo como una
 * virtud: «usa frontera de palabra, así "herido" NO matchea "sin heridos"». El
 * costo estaba del otro lado y nadie lo había medido:
 *
 *   «Hay un herido.»      → high     → va a un especialista
 *   «Hay tres heridos.»   → medium   → no va a nadie
 *   «Hubo un muerto.»     → critical → va a un especialista
 *   «Hubo dos muertos.»   → medium   → no va a nadie
 *
 * El caso más grave era el que se escapaba, por una regla puesta para evitar un
 * falso positivo que ahora se resuelve mirando la negación.
 *
 * Importa aunque el modelo casi siempre acierte: la severidad final es el máximo
 * entre esta capa y la del modelo, o sea que esto es la RED. Una red con un
 * agujero en el plural sirve justo cuando no hace falta.
 */

import { describe, it, expect } from "vitest";

import { classifySeverity } from "@/server/ai/severity-classifier";

/** Sin capa de IA y sin patrones aprendidos: sólo la tabla del código. */
function soloPatrones(texto: string) {
  return classifySeverity(texto, null, []);
}

describe("la capa de patrones ve el plural", () => {
  it("tres heridos pesan al menos tanto como uno", () => {
    expect(soloPatrones("Hay un herido.")).toBe("high");
    expect(soloPatrones("Choqué ayer en la ruta 8, hay tres heridos.")).toBe("high");
  });

  it("dos muertos pesan al menos tanto como uno", () => {
    expect(soloPatrones("Hubo un muerto.")).toBe("critical");
    expect(soloPatrones("Hubo dos muertos.")).toBe("critical");
  });

  it("las ambulancias, igual que la ambulancia", () => {
    expect(soloPatrones("Vino la ambulancia.")).toBe("high");
    expect(soloPatrones("Chocamos y vinieron las ambulancias.")).toBe("high");
  });

  it("y el femenino con su plural", () => {
    expect(soloPatrones("Tiene heridas leves en el brazo.")).toBe("high");
  });
});

describe("una palabra grave negada no escala", () => {
  /*
   * La mitad que hace que la de arriba sea segura. Con el plural adentro y sin
   * esto, «sin heridos» dispararía «heridos» y de ahí a `high`, porque la capa
   * se queda con el máximo y el `sin heridos → low` de la tabla nunca gana.
   */
  it("«sin heridos» no manda a nadie a un especialista", () => {
    expect(soloPatrones("Fue un choque leve, sin heridos.")).toBe("medium");
  });

  it("«no hubo heridos» tampoco", () => {
    expect(soloPatrones("No hubo heridos pero el auto quedó destruido.")).toBe("medium");
  });

  it("«ningún herido» tampoco", () => {
    expect(soloPatrones("Nos chocaron, ningún herido.")).toBe("medium");
    expect(soloPatrones("Sin ningún herido, sólo chapa.")).toBe("medium");
  });

  it("el `ni` arrastra la negación, como en castellano", () => {
    // Vidrio roto y nadie lastimado: `low` es la respuesta correcta.
    expect(soloPatrones("Me rompieron el vidrio, sin heridos ni lesionados.")).toBe("low");
  });
});

describe("la negación no se lleva puesto lo que no niega", () => {
  it("«sin duda hay heridos» SÍ escala", () => {
    /*
     * El borde de la regla. Se permite UNA palabra entre el negador y la
     * palabra grave; acá hay dos («duda hay»), así que no cuenta como negación
     * — y hace falta que no cuente, porque esa frase dice que hay heridos.
     */
    expect(soloPatrones("Sin duda hay heridos.")).toBe("high");
  });

  it("un negador DESPUÉS no niega nada", () => {
    expect(soloPatrones("Hay heridos, sin duda.")).toBe("high");
  });

  it("«ni bien llegó la ambulancia» no niega la ambulancia", () => {
    // «ni bien» es un conector temporal, no una negación. Tres palabras de por
    // medio lo dejan afuera de la regla.
    expect(soloPatrones("Ni bien llegó la ambulancia lo subieron.")).toBe("high");
  });

  it("pero «ni la ambulancia vino» sí, que es lo que esa frase dice", () => {
    expect(soloPatrones("Ni la ambulancia vino.")).toBe("medium");
  });
});

describe("lo que ya andaba sigue andando", () => {
  it("las frases de varias palabras no cambiaron", () => {
    expect(soloPatrones("Robo a mano armada, se llevaron el auto.")).toBe("critical");
    expect(soloPatrones("Se prendió fuego, incendio total.")).toBe("critical");
  });

  it("un choque sin nada más sigue siendo medio", () => {
    expect(soloPatrones("Tuve un choque en la esquina.")).toBe("medium");
  });

  it("sin ninguna palabra conocida, medio por omisión", () => {
    expect(soloPatrones("Buenas, quería consultar una cosa.")).toBe("medium");
  });

  it("la capa del modelo sigue pudiendo escalar por su cuenta", () => {
    // El máximo entre las dos: la de patrones no puede BAJAR lo que dijo el modelo.
    expect(classifySeverity("Tuve un choque en la esquina.", "critical", [])).toBe("critical");
  });
});
