/**
 * Un acuse de recibo no contesta una lista de varias cosas (ensayo `silencio`,
 * 23/09): el «ok» cerraba la duda de los heridos y volvía el pedido entero.
 */

import { describe, it, expect } from "vitest";
import { esSoloUnAcuse } from "@/core/mensajes/acuse";

describe("esSoloUnAcuse", () => {
  it.each(["ok", "Ok.", "ok?", "OKEY", "dale", "Gracias!", "muchas gracias", "Dale, gracias", "perfecto gracias 🙏", "👍", "  listo  "])(
    "«%s» es sólo un acuse",
    (texto) => {
      expect(esSoloUnAcuse(texto)).toBe(true);
    }
  );

  it.each(["sí", "Confirmo", "correcto", "es correcto", "ok, la póliza es POL-123", "ok\nfue el martes", "gracias, ¿cuánto tarda?", "", null, undefined])(
    "«%s» no",
    (texto) => {
      expect(esSoloUnAcuse(texto)).toBe(false);
    }
  );

  it("un mensaje largo no es un acuse, aunque sean todos «ok»", () => {
    expect(esSoloUnAcuse("ok ".repeat(40))).toBe(false);
  });
});
