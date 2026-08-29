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

import { describe, it, expect } from "vitest";

import {
  estadoTrasExtraer,
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
