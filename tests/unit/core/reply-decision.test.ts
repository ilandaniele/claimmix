/**
 * La decisión de si el asegurado recibe un mensaje.
 *
 * Sin un solo mock: entran siete booleanos y sale una decisión. Antes esto
 * vivía dentro de una función de 1.424 líneas enredada con la base, y probar
 * un caso costaba montar media aplicación — por eso el bug de abajo se
 * descubrió con un ensayo contra el agente real, en producción, y no acá.
 */
import { describe, it, expect } from "vitest";
import {
  queHacer,
  elPedidoQuedaEnEspera,
  type SeñalesDeRespuesta,
} from "@/core/case/reply-decision";

/** El caso corriente: falta información, nunca se pidió, nada raro. */
const base: SeñalesDeRespuesta = {
  yaSePidio: false,
  elAgenteEspera: false,
  nosPreguntoAlgo: false,
  llegoUnArchivo: false,
  aprendimosAlgo: false,
  datosQueFaltan: 3,
  esGrave: false,
};

const con = (cambios: Partial<SeñalesDeRespuesta>): SeñalesDeRespuesta => ({
  ...base,
  ...cambios,
});

describe("qué hacer con el asegurado", () => {
  it("pide lo que falta la primera vez", () => {
    expect(queHacer(base)).toBe("pedir");
  });

  it("no repite el pedido si ya se hizo y no pasó nada", () => {
    expect(queHacer(con({ yaSePidio: true }))).toBe("callar");
  });

  it("un caso grave lo toma una persona: no sale nada automático", () => {
    expect(queHacer(con({ esGrave: true }))).toBe("callar");
    // Ni siquiera cuando habría algo que decir.
    expect(queHacer(con({ esGrave: true, yaSePidio: true, aprendimosAlgo: true }))).toBe(
      "callar"
    );
  });

  it("no pide nada si no falta nada", () => {
    expect(queHacer(con({ datosQueFaltan: 0 }))).toBe("callar");
  });
});

describe("el acuse de recibo", () => {
  it("contó algo mientras esperábamos: se le acusa recibo", () => {
    expect(queHacer(con({ yaSePidio: true, aprendimosAlgo: true }))).toBe("acusar-recibo");
  });

  // Este es EL caso. Se descubrió en producción, con el agente real.
  //
  // La extracción relee la conversación entera en cada vuelta, así que un
  // simple «ok» produce campos que antes no estaban guardados —de mensajes
  // viejos, no del último—. Con `aprendimosAlgo` sola, un «ok» y un «gracias»
  // recibían un acuse cada uno: el mismo hostigamiento que la regla de no
  // repetirse evita, con otra plantilla.
  //
  // Cuando el agente deliberó y dijo que esperaba, ya juzgó que el mensaje no
  // aportó nada. Eso se respeta.
  it("un «ok» NO recibe acuse, aunque la extracción produzca campos nuevos", () => {
    expect(
      queHacer(con({ yaSePidio: true, aprendimosAlgo: true, elAgenteEspera: true }))
    ).toBe("callar");
  });

  it("sin datos nuevos no hay acuse: no habría nada que acusar", () => {
    expect(queHacer(con({ yaSePidio: true, aprendimosAlgo: false }))).toBe("callar");
  });
});

describe("qué rompe la espera", () => {
  it("una pregunta suya: se contesta aunque ya se le haya pedido", () => {
    expect(elPedidoQuedaEnEspera(con({ yaSePidio: true, nosPreguntoAlgo: true }))).toBe(
      false
    );
    expect(queHacer(con({ yaSePidio: true, nosPreguntoAlgo: true }))).toBe("pedir");
  });

  it("un archivo que llegó: cambió el estado del pedido", () => {
    expect(elPedidoQuedaEnEspera(con({ yaSePidio: true, llegoUnArchivo: true }))).toBe(
      false
    );
    expect(queHacer(con({ yaSePidio: true, llegoUnArchivo: true }))).toBe("pedir");
  });

  it("el juicio del agente pone el pedido en espera por sí solo", () => {
    // Aunque nunca se haya pedido: si el agente deliberó y decidió esperar,
    // es porque el último mensaje no pide una respuesta.
    expect(elPedidoQuedaEnEspera(con({ elAgenteEspera: true }))).toBe(true);
  });
});
