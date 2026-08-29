/**
 * En qué estado queda el caso apenas se lee el mensaje.
 *
 * Estas cuatro ramas vivían en línea adentro de `runEmailExtractionWorker` y no
 * las cubría NADA: grepeando los seis archivos de test del worker, las únicas
 * apariciones de `status:` son el `recibido` de entrada. Ninguno afirmaba
 * `info_faltante`, `confirmacion_pendiente`, `requiere_especialista` ni `listo`
 * como resultado.
 *
 * O sea que invertir dos `if` —mandar a confirmar un caso al que le faltan
 * datos, o no escalar uno grave— dejaba la suite entera en verde.
 *
 * Lo que se prueba acá no son las cuatro ramas sueltas: es la PRECEDENCIA, que
 * es lo único que se puede romper sin darse cuenta. Cada rama por separado es
 * obvia; el orden entre ellas es la regla.
 */

import { describe, it, expect, vi } from "vitest";

import {
  estadoTrasExtraer,
  sePuedeTransicionar,
  type SeñalesDeExtraccion,
} from "@/core/case/status-after-extraction";

const NADA: SeñalesDeExtraccion = {
  necesitaEspecialista: false,
  camposFaltantes: 0,
  camposPorConfirmar: 0,
};

describe("estadoTrasExtraer — cada rama", () => {
  it("sin nada pendiente, queda listo para revisar", () => {
    expect(estadoTrasExtraer(NADA)).toBe("listo");
  });

  it("si hay que escalar, escala", () => {
    expect(estadoTrasExtraer({ ...NADA, necesitaEspecialista: true })).toBe(
      "requiere_especialista"
    );
  });

  it("si falta un dato, hay información faltante", () => {
    expect(estadoTrasExtraer({ ...NADA, camposFaltantes: 1 })).toBe("info_faltante");
  });

  it("si un dato quedó en duda, queda a confirmar", () => {
    expect(estadoTrasExtraer({ ...NADA, camposPorConfirmar: 1 })).toBe(
      "confirmacion_pendiente"
    );
  });
});

describe("estadoTrasExtraer — la precedencia, que es la regla", () => {
  it("grave gana sobre faltar datos", () => {
    // Lo que sigue lo decide una persona: no tiene sentido pedirle nada al
    // asegurado mientras tanto.
    expect(
      estadoTrasExtraer({
        necesitaEspecialista: true,
        camposFaltantes: 3,
        camposPorConfirmar: 2,
      })
    ).toBe("requiere_especialista");
  });

  it("grave gana también sobre dudar de un dato", () => {
    expect(
      estadoTrasExtraer({ ...NADA, necesitaEspecialista: true, camposPorConfirmar: 5 })
    ).toBe("requiere_especialista");
  });

  it("faltar un dato gana sobre dudar de otro", () => {
    // Sin el dato no se puede avanzar; con el dudoso sí, mal pero se puede.
    expect(
      estadoTrasExtraer({ ...NADA, camposFaltantes: 1, camposPorConfirmar: 9 })
    ).toBe("info_faltante");
  });
});

describe("estadoTrasExtraer — los bordes de los contadores", () => {
  it("cero no es «hay»", () => {
    // Un `>= 0` en vez de `> 0` mandaría todos los casos a info_faltante, y
    // ningún test de los otros lo notaría porque todos pasan números > 0.
    expect(estadoTrasExtraer({ ...NADA, camposFaltantes: 0 })).toBe("listo");
    expect(estadoTrasExtraer({ ...NADA, camposPorConfirmar: 0 })).toBe("listo");
  });

  it("uno alcanza", () => {
    expect(estadoTrasExtraer({ ...NADA, camposFaltantes: 1 })).not.toBe("listo");
    expect(estadoTrasExtraer({ ...NADA, camposPorConfirmar: 1 })).not.toBe("listo");
  });
});

/**
 * La guarda de la máquina de estados, que es la otra mitad del mismo bloque.
 *
 * La decisión de arriba dice a dónde QUERRÍA ir el caso; ésta dice si se puede.
 * También vivía en línea adentro del worker, también es pura, y tampoco la
 * probaba nadie.
 *
 * Se le pasa el `permite` en vez de importarlo para poder mirar CUÁNDO se
 * consulta la máquina de estados y cuándo se saltea: las dos excepciones son
 * justamente saltearla.
 */
describe("sePuedeTransicionar", () => {
  it("desde recibido siempre se puede, sin preguntarle a la máquina", () => {
    // `recibido` es donde nace un caso de correo. Si esto preguntara, el worker
    // no podría mover nunca un caso recién llegado, que es lo único que hace.
    const permite = vi.fn().mockReturnValue(false);

    expect(sePuedeTransicionar("recibido", "info_faltante", permite)).toBe(true);
    expect(permite).not.toHaveBeenCalled();
  });

  it("desde procesando también: es donde el worker deja el caso mientras trabaja", () => {
    const permite = vi.fn().mockReturnValue(false);

    expect(sePuedeTransicionar("procesando", "listo", permite)).toBe(true);
    expect(permite).not.toHaveBeenCalled();
  });

  it("quedarse donde está no necesita permiso", () => {
    const permite = vi.fn().mockReturnValue(false);

    expect(sePuedeTransicionar("cerrado", "cerrado", permite)).toBe(true);
    expect(permite).not.toHaveBeenCalled();
  });

  it("desde cualquier otro estado, decide la máquina", () => {
    // Acá está lo que la guarda protege: un caso que ya avanzó no se mueve
    // porque la extracción lo diga.
    const niega = vi.fn().mockReturnValue(false);
    expect(sePuedeTransicionar("cerrado", "listo", niega)).toBe(false);
    expect(niega).toHaveBeenCalledWith("cerrado", "listo");

    const acepta = vi.fn().mockReturnValue(true);
    expect(sePuedeTransicionar("info_faltante", "listo", acepta)).toBe(true);
  });

  it("contra la máquina de verdad: un caso cerrado no vuelve a listo", async () => {
    // Los de arriba usan un doble. Éste usa la FSM real, para que la excepción
    // de `recibido` no tape una transición que el producto no permite.
    const { isValidTransition } = await import("@/core/case/fsm");

    expect(sePuedeTransicionar("cerrado", "listo", isValidTransition)).toBe(false);
    expect(sePuedeTransicionar("recibido", "listo", isValidTransition)).toBe(true);
  });
});
