import { describe, expect, it } from "vitest";

import { MecanicaSchema, mecanicaJson, type Mecanica } from "@/core/case/mecanica";
import { leerResponsabilidad, opinarResponsabilidad, responsabilidadDelCaso } from "@/core/case/responsabilidad";

const vacia: Mecanica = {
  maniobra_asegurado: null,
  maniobra_tercero: null,
  semaforo_asegurado: null,
  semaforo_tercero: null,
  interseccion: null,
  venia_por_la_derecha: null,
  embistio_de_atras: null,
  excepcion_prioridad: null,
};
const mec = (c: Partial<Mecanica>): Mecanica => ({ ...vacia, ...c });

const andando = { maniobra_asegurado: "avanzaba_recto", maniobra_tercero: "avanzaba_recto" } as const;

// El art. 41 rige en un cruce sin semáforo: el relato tiene que decirlo, no callarlo.
const cruce = (c: Partial<Mecanica> = {}) =>
  mec({
    interseccion: true,
    maniobra_asegurado: "avanzaba_recto",
    maniobra_tercero: "avanzaba_recto",
    semaforo_asegurado: "sin_semaforo",
    semaforo_tercero: "sin_semaforo",
    ...c,
  });

describe("opinarResponsabilidad", () => {
  it("semáforo en rojo del tercero: responde el tercero, art. 44", () => {
    const o = opinarResponsabilidad(mec({ ...andando, semaforo_tercero: "rojo", semaforo_asegurado: "verde" }), []);
    expect(o).toMatchObject({ responsable: "tercero", regla: "ley24449_art44", faltantes: [], difiere: false });
    expect(o.motivo).toEqual({ clave: "semaforo_rojo", params: { parte: "tercero" } });
  });

  it("semáforo en rojo del asegurado: responde el asegurado", () => {
    const o = opinarResponsabilidad(mec({ ...andando, semaforo_asegurado: "rojo", semaforo_tercero: "verde" }), []);
    expect(o).toMatchObject({ responsable: "asegurado", regla: "ley24449_art44" });
  });

  it("quieto frente al rojo, con el otro andando en verde: no responde el que estaba parado", () => {
    const o = opinarResponsabilidad(
      mec({ semaforo_asegurado: "rojo", semaforo_tercero: "verde", maniobra_asegurado: "detenido", maniobra_tercero: "avanzaba_recto" }),
      []
    );
    expect(o).toMatchObject({ responsable: "tercero", regla: null });
    expect(o.motivo.clave).toBe("detenido");
    const al_reves = opinarResponsabilidad(
      mec({ semaforo_tercero: "rojo", semaforo_asegurado: "verde", maniobra_tercero: "estacionado", maniobra_asegurado: "giraba_izquierda" }),
      []
    );
    expect(al_reves).toMatchObject({ responsable: "asegurado", regla: null });
  });

  it("sin saber qué hacía el que enfrentaba el rojo, no se le atribuye haberlo cruzado", () => {
    const o = opinarResponsabilidad(mec({ semaforo_tercero: "rojo", semaforo_asegurado: "verde" }), []);
    expect(o.responsable).toBe("no_determinable");
    expect(o.faltantes).toEqual(expect.arrayContaining(["maniobra_asegurado", "maniobra_tercero"]));
  });

  it("con luz de un solo lado, o en rojo de los dos, el semáforo no decide", () => {
    expect(opinarResponsabilidad(mec({ semaforo_tercero: "rojo" }), []).responsable).toBe("no_determinable");
    expect(
      opinarResponsabilidad(mec({ semaforo_tercero: "rojo", semaforo_asegurado: "rojo" }), []).responsable
    ).toBe("no_determinable");
    expect(
      opinarResponsabilidad(mec({ semaforo_tercero: "rojo", semaforo_asegurado: "no_dice" }), []).responsable
    ).toBe("no_determinable");
  });

  it("alcance: quien pegó de atrás responde por el art. 48 inc. g, no por el inc. a", () => {
    const o = opinarResponsabilidad(mec({ embistio_de_atras: "asegurado" }), []);
    expect(o).toMatchObject({ responsable: "asegurado", regla: "ley24449_art48g" });
    expect(o.regla).not.toContain("art48a");
    expect(opinarResponsabilidad(mec({ embistio_de_atras: "tercero" }), []).responsable).toBe("tercero");
  });

  it("derecha sin excepción: responde el que NO venía por la derecha, art. 41", () => {
    const delAsegurado = opinarResponsabilidad(cruce({ venia_por_la_derecha: true, excepcion_prioridad: false }), []);
    expect(delAsegurado).toMatchObject({ responsable: "tercero", regla: "ley24449_art41" });
    const delTercero = opinarResponsabilidad(cruce({ venia_por_la_derecha: false, excepcion_prioridad: false }), []);
    expect(delTercero).toMatchObject({ responsable: "asegurado", regla: "ley24449_art41" });
  });

  it("derecha con excepción o sin saberla: no determinable y pide la excepción", () => {
    for (const excepcion of [true, null]) {
      const o = opinarResponsabilidad(cruce({ venia_por_la_derecha: true, excepcion_prioridad: excepcion }), []);
      expect(o.responsable).toBe("no_determinable");
      expect(o.regla).toBeNull();
      expect(o.faltantes).toContain("excepcion_prioridad");
    }
    expect(opinarResponsabilidad(cruce({ venia_por_la_derecha: true, excepcion_prioridad: true }), []).motivo.clave).toBe(
      "excepcion_prioridad"
    );
  });

  it("derecha sin saber quién venía por ella: lo pide", () => {
    const o = opinarResponsabilidad(cruce({ excepcion_prioridad: false }), []);
    expect(o.responsable).toBe("no_determinable");
    expect(o.faltantes).toContain("quien_venia_por_la_derecha");
  });

  it("con un semáforo con luz en el cruce, la prioridad de la derecha no se cita", () => {
    const o = opinarResponsabilidad(
      cruce({ venia_por_la_derecha: true, excepcion_prioridad: false, semaforo_asegurado: "verde", semaforo_tercero: "verde" }),
      []
    );
    expect(o.responsable).toBe("no_determinable");
  });

  it("con el semáforo sin saber o sin decir, la prioridad de la derecha no se cita y se pide el semáforo", () => {
    for (const semaforo of [null, "no_dice"] as const) {
      for (const lado of ["semaforo_asegurado", "semaforo_tercero"] as const) {
        const o = opinarResponsabilidad(
          cruce({ venia_por_la_derecha: true, excepcion_prioridad: false, [lado]: semaforo }),
          []
        );
        expect(o.responsable).toBe("no_determinable");
        expect(o.regla).toBeNull();
        expect(o.faltantes).toContain(lado);
      }
    }
  });

  it("estacionado contra uno en marcha: responde el que andaba y no cita artículo", () => {
    const o = opinarResponsabilidad(mec({ maniobra_asegurado: "estacionado", maniobra_tercero: "avanzaba_recto" }), []);
    expect(o).toMatchObject({ responsable: "tercero", regla: null });
    expect(o.motivo.clave).toBe("detenido");
    const al_reves = opinarResponsabilidad(mec({ maniobra_asegurado: "retrocedia", maniobra_tercero: "detenido" }), []);
    expect(al_reves).toMatchObject({ responsable: "asegurado", regla: null });
  });

  it("dos vehículos quietos, o uno con una maniobra «otra», no dan responsable", () => {
    expect(
      opinarResponsabilidad(mec({ maniobra_asegurado: "estacionado", maniobra_tercero: "detenido" }), []).responsable
    ).toBe("no_determinable");
    expect(
      opinarResponsabilidad(mec({ maniobra_asegurado: "estacionado", maniobra_tercero: "otra" }), []).responsable
    ).toBe("no_determinable");
  });

  it("datos insuficientes: no determinable con lo que falta, nunca asegurado ni tercero", () => {
    const o = opinarResponsabilidad(vacia, []);
    expect(o.responsable).toBe("no_determinable");
    expect(o.regla).toBeNull();
    expect(o.faltantes.length).toBeGreaterThan(0);
    expect(o.faltantes).toContain("parte_o_denuncia");
    expect(["asegurado", "tercero"]).not.toContain(o.responsable);
  });

  it("con un documento leído, ya no pide el parte", () => {
    const o = opinarResponsabilidad(vacia, [mec({ maniobra_asegurado: "avanzaba_recto" })]);
    expect(o.faltantes).not.toContain("parte_o_denuncia");
    expect(o.faltantes).not.toContain("maniobra_asegurado");
  });

  it("el documento prevalece sobre el relato y se avisa que difieren", () => {
    const relato = mec({ ...andando, semaforo_tercero: "verde", semaforo_asegurado: "verde" });
    const parte = mec({ ...andando, semaforo_tercero: "rojo", semaforo_asegurado: "verde" });
    const o = opinarResponsabilidad(relato, [parte]);
    expect(o).toMatchObject({ responsable: "tercero", regla: "ley24449_art44", difiere: true });
  });

  it("si el relato y el documento coinciden, no difiere", () => {
    const m = mec({ embistio_de_atras: "tercero" });
    expect(opinarResponsabilidad(m, [m]).difiere).toBe(false);
  });

  it("dos documentos que se contradicen dejan el campo sin dato", () => {
    const a = mec({ embistio_de_atras: "asegurado" });
    const b = mec({ embistio_de_atras: "tercero" });
    const o = opinarResponsabilidad(mec({ embistio_de_atras: "tercero" }), [a, b]);
    expect(o.responsable).toBe("no_determinable");
    expect(o.difiere).toBe(true);
  });

  it("compartida sólo cuando dos reglas apuntan a partes distintas", () => {
    const o = opinarResponsabilidad(
      mec({ ...andando, semaforo_tercero: "rojo", semaforo_asegurado: "verde", embistio_de_atras: "tercero" }),
      []
    );
    expect(o.responsable).toBe("tercero");
    const compartida = opinarResponsabilidad(
      mec({ ...andando, semaforo_tercero: "rojo", semaforo_asegurado: "verde", embistio_de_atras: "asegurado" }),
      []
    );
    expect(compartida).toMatchObject({ responsable: "compartida", regla: null });
    expect(compartida.motivo).toEqual({
      clave: "compartida",
      params: { reglas: "ley24449_art44,ley24449_art48g" },
    });
  });

  it("dos reglas que apuntan a la misma parte no la hacen compartida", () => {
    const o = opinarResponsabilidad(
      mec({ maniobra_asegurado: "estacionado", maniobra_tercero: "avanzaba_recto", embistio_de_atras: "tercero" }),
      []
    );
    expect(o).toMatchObject({ responsable: "tercero", regla: "ley24449_art48g" });
  });
});

describe("responsabilidadDelCaso", () => {
  const alcance = mec({ embistio_de_atras: "asegurado" });

  it("calcula la opinión de un choque", () => {
    expect(responsabilidadDelCaso("choque", alcance, [])).toMatchObject({ responsable: "asegurado" });
  });

  it("un choque donde el asegurado responde ante un tercero (rc) también tiene opinión", () => {
    expect(responsabilidadDelCaso("rc", alcance, [])).toMatchObject({ responsable: "asegurado" });
  });

  it("si el caso ya no es un choque, borra la opinión que había", () => {
    expect(responsabilidadDelCaso("robo", alcance, [])).toBeNull();
    expect(responsabilidadDelCaso("other", alcance, [])).toBeNull();
    expect(responsabilidadDelCaso(null, alcance, [])).toBeNull();
  });

  it("no escribe nada si ninguna fuente dice algo de la mecánica", () => {
    expect(responsabilidadDelCaso("choque", null, [])).toBeUndefined();
    expect(responsabilidadDelCaso("rc", vacia, [null, vacia])).toBeUndefined();
  });
});

describe("leerResponsabilidad", () => {
  it("lo que se guardó vuelve igual, viniendo de jsonb", () => {
    const o = opinarResponsabilidad(mec({ embistio_de_atras: "tercero" }), []);
    expect(leerResponsabilidad(JSON.parse(JSON.stringify(o)))).toEqual(o);
  });

  it.each([
    ["null", null],
    ["un texto", "tercero"],
    ["un responsable que no existe", { v: 1, responsable: "el vecino", regla: null, motivo: { clave: "sin_regla", params: {} }, faltantes: [], difiere: false }],
    ["una regla que no existe", { v: 1, responsable: "tercero", regla: "ley24449_art1", motivo: { clave: "sin_regla", params: {} }, faltantes: [], difiere: false }],
    ["una versión de otro día", { v: 2, responsable: "tercero", regla: null, motivo: { clave: "sin_regla", params: {} }, faltantes: [], difiere: false }],
  ])("%s no se muestra", (_c, valor) => {
    expect(leerResponsabilidad(valor)).toBeNull();
  });
});

describe("MecanicaSchema", () => {
  it("un valor fuera de la lista queda en null sin tirar el resto", () => {
    const r = MecanicaSchema.parse({ ...vacia, semaforo_tercero: "naranja", embistio_de_atras: "asegurado", interseccion: "si" });
    expect(r.semaforo_tercero).toBeNull();
    expect(r.interseccion).toBeNull();
    expect(r.embistio_de_atras).toBe("asegurado");
  });

  it("el esquema JSON pide las mismas claves y las mismas listas que Zod", () => {
    expect(Object.keys(mecanicaJson.properties).sort()).toEqual(Object.keys(MecanicaSchema.shape).sort());
    expect([...mecanicaJson.required].sort()).toEqual(Object.keys(MecanicaSchema.shape).sort());
    expect(mecanicaJson.properties.embistio_de_atras.enum).toEqual(["asegurado", "tercero", null]);
  });
});
