import { describe, it, expect } from "vitest";
import { motivoPropioDelDescarte } from "@/core/case/motivo-del-descarte";

describe("motivoPropioDelDescarte", () => {
  it("devuelve el motivo que dio el modelo", () => {
    expect(motivoPropioDelDescarte("Es publicidad de un comercio")).toBe("Es publicidad de un comercio");
  });

  it("recorta los espacios de los bordes", () => {
    expect(motivoPropioDelDescarte("  Es un saludo  \n")).toBe("Es un saludo");
  });

  it("el texto fijo de antes no es un motivo propio", () => {
    expect(
      motivoPropioDelDescarte("El clasificador de IA determinó que este email no es un reclamo de seguro")
    ).toBeNull();
    expect(motivoPropioDelDescarte("  El clasificador de IA determinó otra cosa")).toBeNull();
  });

  it("sin motivo, o en blanco, devuelve null", () => {
    expect(motivoPropioDelDescarte(null)).toBeNull();
    expect(motivoPropioDelDescarte(undefined)).toBeNull();
    expect(motivoPropioDelDescarte("")).toBeNull();
    expect(motivoPropioDelDescarte("   ")).toBeNull();
  });

  it("un motivo que sólo nombra al clasificador en el medio sí es propio", () => {
    const motivo = "Según el clasificador de IA no hay siniestro";
    expect(motivoPropioDelDescarte(motivo)).toBe(motivo);
  });
});
