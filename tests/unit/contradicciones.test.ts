import { describe, expect, it } from "vitest";

import { cruzarDocumentos, fusionarIndicadores, type IndicioDerivado } from "@/core/case/contradicciones";
import { enUS } from "@/lib/i18n/en-US";
import { puedeSerDe } from "@/core/geo/provincias";
import type { DocumentoLeido } from "@/lib/schemas/extracted-claim";

const AHORA = new Date("2026-09-20T15:00:00Z");
const doc = (d: Partial<DocumentoLeido>): DocumentoLeido => ({
  tipo: null, fecha: null, patente: null, dni: null, nombre: null, lugar: null, provincia: null, ...d,
});
const reclamo = {
  fecha: "2026-09-10",
  provincia: "Buenos Aires",
  patentes: ["AB 123 CD"],
  dni: "30.111.222",
  nombre: "Juana Prueba",
};
const cruzar = (e: Partial<Parameters<typeof cruzarDocumentos>[0]>) =>
  cruzarDocumentos({ documentos: [], fotos: [], reclamo, poliza: null, ahora: AHORA, ...e });
const tipos = (r: IndicioDerivado[]) => r.map((i) => i.type);

describe("cruzarDocumentos — fechas", () => {
  it("una constancia con la fecha corrida tres días marca línea de tiempo", () => {
    const r = cruzar({ documentos: [doc({ tipo: "Constancia de denuncia", fecha: "13/09/2026" })] });
    expect(tipos(r)).toEqual(["timeline_inconsistency"]);
    expect(r[0]!.origen).toBe("documentos");
  });

  it("un día de diferencia no marca: la denuncia se hace al día siguiente", () => {
    expect(cruzar({ documentos: [doc({ tipo: "denuncia policial", fecha: "2026-09-11" })] })).toEqual([]);
  });

  it("la fecha de un registro no se compara con el siniestro", () => {
    expect(cruzar({ documentos: [doc({ tipo: "licencia de conducir", fecha: "2030-01-01" })] })).toEqual([]);
  });

  it("una fecha que no se entiende, o un reclamo sin fecha, no marca", () => {
    expect(cruzar({ documentos: [doc({ tipo: "constancia", fecha: "el martes" })] })).toEqual([]);
    expect(
      cruzar({ reclamo: { ...reclamo, fecha: null }, documentos: [doc({ tipo: "constancia", fecha: "2026-01-01" })] })
    ).toEqual([]);
  });
});

describe("cruzarDocumentos — patentes, DNI y nombres", () => {
  it("la misma patente escrita distinto no marca; otra patente sí", () => {
    expect(cruzar({ documentos: [doc({ patente: "ab-123-cd" })] })).toEqual([]);
    expect(tipos(cruzar({ documentos: [doc({ patente: "ZZ999ZZ" })] }))).toEqual(["documentation_gap"]);
  });

  it("la patente de la póliza también vale", () => {
    const poliza = { patentes: ["ZZ999ZZ"], dni: null, titular: null };
    expect(cruzar({ poliza, documentos: [doc({ patente: "ZZ 999 ZZ" })] })).toEqual([]);
  });

  it("sin ninguna patente con qué comparar, no marca", () => {
    const r = cruzar({ reclamo: { ...reclamo, patentes: [] }, documentos: [doc({ patente: "ZZ999ZZ" })] });
    expect(r).toEqual([]);
  });

  it("el DNI de la persona con otro número marca; en una constancia no", () => {
    const suyo = { nombre: "Juana Prueba", dni: "99888777" };
    expect(cruzar({ documentos: [doc({ tipo: "DNI", ...suyo })] })).toEqual([
      expect.objectContaining({ clave: "documento_dni" }),
    ]);
    expect(cruzar({ documentos: [doc({ tipo: "constancia", ...suyo })] })).toEqual([]);
    expect(cruzar({ documentos: [doc({ tipo: "DNI", nombre: "Juana Prueba", dni: "30111222" })] })).toEqual([]);
  });

  it("un DNI demasiado corto para buscar no se compara", () => {
    expect(cruzar({ documentos: [doc({ tipo: "DNI", nombre: "Juana Prueba", dni: "12.345" })] })).toEqual([]);
  });

  it("el número de la persona con otro nombre marca; uno compatible con el titular no", () => {
    const poliza = { patentes: [], dni: "20.555.666", titular: "PEREZ MARIA" };
    expect(cruzar({ poliza, documentos: [doc({ tipo: "licencia", nombre: "María Pérez", dni: "20555666" })] })).toEqual([]);
    expect(cruzar({ documentos: [doc({ tipo: "licencia", nombre: "Otro Señor", dni: "30111222" })] })).toEqual([
      expect.objectContaining({ clave: "documento_nombre" }),
    ]);
  });

  it("la licencia o la cédula del tercero, o de un conductor que no es el titular, no marca", () => {
    const poliza = { patentes: [], dni: "20.555.666", titular: "Carlos Prueba" };
    const documentos = [
      doc({ tipo: "licencia de conducir", nombre: "Otro Señor", dni: "99888777" }),
      doc({ tipo: "cédula verde", nombre: "Otro Señor" }),
      doc({ tipo: "DNI", dni: "99888777" }),
      // El hijo del titular maneja con su licencia: comparte el apellido, no es él.
      doc({ tipo: "licencia", nombre: "Pedro Prueba", dni: "41222333" }),
    ];
    expect(cruzar({ poliza, reclamo: { ...reclamo, dni: null, nombre: "Pedro Prueba" }, documentos })).toEqual([]);
    expect(cruzar({ poliza, documentos })).toEqual([]);
  });

  it("las descripciones no llevan datos del documento y no se repiten", () => {
    const r = cruzar({ documentos: [doc({ patente: "ZZ999ZZ" }), doc({ patente: "YY888YY" })] });
    expect(r).toHaveLength(1);
    expect(r[0]!.description).not.toMatch(/ZZ|YY|999|888/);
  });

  it("cada indicio lleva su clave, con la que la ficha lo traduce", () => {
    const [i] = cruzar({ documentos: [doc({ patente: "ZZ999ZZ" })] });
    expect(i).toMatchObject({ clave: "documento_patente", origen: "documentos" });
    expect(enUS[`fraude.derivado.${i!.clave}`]).toMatch(/plate/i);
  });
});

describe("cruzarDocumentos — fotos", () => {
  it("una foto de antes del siniestro marca; una del mismo día no", () => {
    expect(tipos(cruzar({ fotos: [{ tomadaEn: "2026-09-01T12:00:00Z" }] }))).toEqual(["timeline_inconsistency"]);
    expect(cruzar({ fotos: [{ tomadaEn: "2026-09-10T02:00:00Z" }] })).toEqual([]);
  });

  it("una foto fechada en el futuro marca", () => {
    expect(tipos(cruzar({ fotos: [{ tomadaEn: "2026-12-01T12:00:00Z" }] }))).toEqual(["timeline_inconsistency"]);
  });

  it("una foto sacada días después del siniestro es lo normal", () => {
    expect(cruzar({ fotos: [{ tomadaEn: "2026-09-15T12:00:00Z" }] })).toEqual([]);
  });

  it("GPS fuera del país o de la provincia marca lugar; adentro no", () => {
    expect(cruzar({ fotos: [{ lat: -38.72, lon: -62.27 }] })).toEqual([]); // Bahía Blanca
    const mendoza = cruzar({ fotos: [{ lat: -32.89, lon: -68.84 }] });
    expect(mendoza.map((i) => i.description)).toEqual(["Una foto adjunta se sacó fuera de la provincia del siniestro."]);
    const madrid = cruzar({ fotos: [{ lat: 40.4, lon: -3.7 }] });
    expect(madrid.map((i) => i.description)).toEqual(["Una foto adjunta se sacó fuera del país."]);
  });
});

describe("puedeSerDe", () => {
  it("CABA se mide como la provincia entera, que es como se confunde al hablar", () => {
    expect(puedeSerDe(-34.92, -57.95, "CABA")).toBe(true); // La Plata
    expect(puedeSerDe(-34.6, -58.4, "Provincia de Buenos Aires")).toBe(true);
  });

  it("una provincia que no reconoce no marca", () => {
    expect(puedeSerDe(-32.89, -68.84, "Narnia")).toBe(true);
    expect(puedeSerDe(-32.89, -68.84, "Córdoba")).toBe(false);
  });
});

describe("fusionarIndicadores", () => {
  const derivado = (description: string): IndicioDerivado => ({
    type: "documentation_gap",
    description,
    origen: "documentos",
    clave: "documento_patente",
  });
  const modelo = { nivel: "none" as const, indicios: [] };

  it("sin nada de nada no escribe", () => {
    expect(fusionarIndicadores({ modelo, existentes: { nivel: null, indicios: null }, derivados: [] })).toBeNull();
  });

  it("un derivado solo es bajo; dos, medio", () => {
    expect(fusionarIndicadores({ modelo, existentes: { nivel: "none", indicios: [] }, derivados: [derivado("a")] })?.nivel).toBe("low");
    expect(
      fusionarIndicadores({ modelo, existentes: { nivel: "none", indicios: [] }, derivados: [derivado("a"), derivado("b")] })?.nivel
    ).toBe("medium");
  });

  it("el nivel que puso el modelo no baja", () => {
    const r = fusionarIndicadores({ modelo, existentes: { nivel: "high", indicios: [] }, derivados: [derivado("a")] });
    expect(r?.nivel).toBe("high");
  });

  it("lo que subió un derivado se va con él, y la ficha queda limpia", () => {
    const viejo = { type: "documentation_gap", description: "viejo", origen: "documentos" };
    expect(fusionarIndicadores({ modelo, existentes: { nivel: "low", indicios: [viejo] }, derivados: [] })).toEqual({
      nivel: "none",
      indicios: [],
    });
    expect(
      fusionarIndicadores({ modelo, existentes: { nivel: "medium", indicios: [viejo, viejo] }, derivados: [derivado("a")] })
        ?.nivel
    ).toBe("low");
  });

  it("lo que el modelo puso por encima de los derivados queda", () => {
    const r = fusionarIndicadores({
      modelo,
      existentes: {
        nivel: "medium",
        indicios: [
          { type: "behavior_signal", description: "del modelo" },
          { type: "documentation_gap", description: "viejo", origen: "documentos" },
        ],
      },
      derivados: [],
    });
    expect(r).toEqual({ nivel: "medium", indicios: [{ type: "behavior_signal", description: "del modelo" }] });
  });

  it("nunca none con indicios", () => {
    const r = fusionarIndicadores({
      modelo: { nivel: "none", indicios: [{ type: "other", description: "x" }] },
      existentes: { nivel: null, indicios: null },
      derivados: [],
    });
    expect(r?.nivel).toBe("low");
  });

  it("los derivados de antes se reemplazan y los del modelo quedan si el modelo no trajo nuevos", () => {
    const r = fusionarIndicadores({
      modelo,
      existentes: {
        nivel: "medium",
        indicios: [
          { type: "behavior_signal", description: "del modelo" },
          { type: "documentation_gap", description: "viejo", origen: "documentos" },
          "basura",
        ],
      },
      derivados: [derivado("nuevo")],
    });
    expect(r?.indicios.map((i) => i.description)).toEqual(["del modelo", "nuevo"]);
  });

  it("los del modelo de esta corrida reemplazan a los suyos de antes", () => {
    const r = fusionarIndicadores({
      modelo: { nivel: "low", indicios: [{ type: "other", description: "hoy" }] },
      existentes: { nivel: "low", indicios: [{ type: "other", description: "ayer" }] },
      derivados: [],
    });
    expect(r?.indicios).toEqual([{ type: "other", description: "hoy" }]);
  });
});
