/**
 * Qué filas de `missing_docs` siguen siendo un faltante cuando se las lee.
 *
 * El extractor manda `dni` y `dni_asegurado` en el mismo mensaje y quedan dos
 * filas por una sola pregunta; y un dato que llegó después sigue «pendiente»
 * hasta que alguien lo confirme. Esto sólo filtra: no cierra nada.
 */

import { describe, it, expect } from "vitest";
import {
  CONFIANZA_DE_DATO_PRESENTE,
  clavesQueLoCierran,
  faltantesVigentes,
} from "@/core/case/faltantes-vigentes";
import { CLAVES_DE_DATO, clavesDelMismoCampo, labelForField } from "@/lib/labels/claim-fields";

const pendiente = (doc_key: string) => ({ doc_key, satisfied_at: null, declined_at: null });
const recibido = (doc_key: string) => ({ doc_key, satisfied_at: "2026-10-01T00:00:00Z", declined_at: null });
const rechazado = (doc_key: string) => ({ doc_key, satisfied_at: null, declined_at: "2026-10-01T00:00:00Z" });
const campo = (field_key: string, field_value: string | null, confidence: number | string | null) => ({
  field_key,
  field_value,
  confidence,
});

describe("faltantesVigentes: una fila por dato", () => {
  it("dni y dni_asegurado pendientes dan una sola fila, la primera", () => {
    const docs = [pendiente("dni"), pendiente("dni_asegurado")];
    expect(faltantesVigentes(docs, [])).toEqual([docs[0]]);
  });

  it("entre alias, recibido le gana a pendiente", () => {
    const docs = [pendiente("dni"), recibido("dni_asegurado")];
    expect(faltantesVigentes(docs, [])).toEqual([docs[1]]);
  });

  it("entre alias, rechazado le gana a pendiente y pierde contra recibido", () => {
    const rech = [pendiente("dni"), rechazado("dni_asegurado")];
    expect(faltantesVigentes(rech, [])).toEqual([rech[1]]);

    const rec = [rechazado("dni"), recibido("dni_asegurado")];
    expect(faltantesVigentes(rec, [])).toEqual([rec[1]]);
  });

  it("las filas de claves distintas no se mezclan", () => {
    const docs = [pendiente("dni"), pendiente("fotos_danos"), pendiente("dni_asegurado")];
    expect(faltantesVigentes(docs, []).map((d) => d.doc_key)).toEqual(["dni", "fotos_danos"]);
  });
});

describe("faltantesVigentes: un dato que ya está presente", () => {
  it("un dato pendiente desaparece con un campo de confianza 0.6 y valor", () => {
    const docs = [pendiente("accident_location")];
    expect(faltantesVigentes(docs, [campo("accident_location", "Bahía Blanca", 0.6)])).toEqual([]);
  });

  it("acepta la confianza como texto, como la devuelve la columna numeric", () => {
    const docs = [pendiente("accident_location")];
    expect(faltantesVigentes(docs, [campo("accident_location", "Bahía Blanca", "0.60")])).toEqual([]);
  });

  it("el dato queda si la confianza es 0.59", () => {
    const docs = [pendiente("accident_location")];
    expect(faltantesVigentes(docs, [campo("accident_location", "Bahía Blanca", 0.59)])).toEqual(docs);
  });

  it("el dato queda si el valor está en blanco o la confianza no es un número", () => {
    const docs = [pendiente("accident_location")];
    expect(faltantesVigentes(docs, [campo("accident_location", "   ", 0.95)])).toEqual(docs);
    expect(faltantesVigentes(docs, [campo("accident_location", null, 0.95)])).toEqual(docs);
    expect(faltantesVigentes(docs, [campo("accident_location", "Bahía Blanca", null)])).toEqual(docs);
  });

  it("el umbral se puede pasar", () => {
    const docs = [pendiente("accident_location")];
    const campos = [campo("accident_location", "Bahía Blanca", 0.7)];
    expect(faltantesVigentes(docs, campos, 0.85)).toEqual(docs);
    expect(CONFIANZA_DE_DATO_PRESENTE).toBe(0.6);
  });

  it("un alias del campo cierra la fila, y al revés", () => {
    expect(faltantesVigentes([pendiente("dni_asegurado")], [campo("dni", "30145882", 0.9)])).toEqual([]);
    expect(faltantesVigentes([pendiente("dni")], [campo("dni_asegurado", "30145882", 0.9)])).toEqual([]);
  });

  it("una alternativa de SATISFECHO_POR cierra el dato", () => {
    const docs = [pendiente("patente_vehiculo")];
    expect(faltantesVigentes(docs, [campo("vehicle_plate", "AB123CD", 0.9)])).toEqual([]);
    expect(faltantesVigentes(docs, [campo("party_a_plate", "AB123CD", 0.9)])).toEqual([]);
  });

  it("la patente del tercero no cierra la del asegurado", () => {
    const docs = [pendiente("patente_vehiculo")];
    expect(faltantesVigentes(docs, [campo("party_b_plate", "AB123CD", 0.9)])).toEqual(docs);
  });

  it("un campo de otra clave no cierra nada", () => {
    const docs = [pendiente("accident_location")];
    expect(faltantesVigentes(docs, [campo("full_name", "Ana Pérez", 0.95)])).toEqual(docs);
  });

  it("recibido y rechazado no se tocan aunque haya un campo", () => {
    const docs = [recibido("dni"), rechazado("accident_location")];
    const campos = [campo("dni", "30145882", 0.95), campo("accident_location", "Bahía Blanca", 0.95)];
    expect(faltantesVigentes(docs, campos)).toEqual(docs);
  });
});

describe("faltantesVigentes: lo que no se toca", () => {
  it("un documento pendiente queda aunque haya un campo con su clave", () => {
    const docs = [pendiente("fotos_danos")];
    expect(faltantesVigentes(docs, [campo("fotos_danos", "sí", 0.99)])).toEqual(docs);
  });

  it("una clave desconocida queda", () => {
    const docs = [pendiente("clave_que_nadie_vio")];
    expect(faltantesVigentes(docs, [campo("clave_que_nadie_vio", "algo", 0.99)])).toEqual(docs);
  });

  it("no cambia el arreglo que recibe", () => {
    const docs = [pendiente("dni"), pendiente("dni_asegurado")];
    faltantesVigentes(docs, [campo("dni", "30145882", 0.9)]);
    expect(docs).toHaveLength(2);
  });
});

describe("claves del mismo campo", () => {
  it("clavesDelMismoCampo('dni') incluye dni y dni_asegurado, sin repetidos", () => {
    const claves = clavesDelMismoCampo("dni");
    expect(claves).toEqual(expect.arrayContaining(["dni", "dni_asegurado"]));
    expect(new Set(claves).size).toBe(claves.length);
  });

  it("parte de un alias y llega a la canónica y a los demás alias", () => {
    expect(clavesDelMismoCampo("heridos")).toEqual(
      expect.arrayContaining(["heridos", "hay_heridos", "injury_severity"])
    );
  });

  it("una clave sin alias es sólo ella", () => {
    expect(clavesDelMismoCampo("fotos_danos")).toEqual(["fotos_danos"]);
    expect(clavesDelMismoCampo("clave_que_nadie_vio")).toEqual(["clave_que_nadie_vio"]);
  });

  it("clavesQueLoCierran suma las alternativas y sus alias, sin repetidos", () => {
    const claves = clavesQueLoCierran("patente_vehiculo");
    expect(claves).toEqual(
      expect.arrayContaining(["patente_vehiculo", "party_a_plate", "vehicle_plate", "patente"])
    );
    expect(claves).not.toContain("party_b_plate");
    expect(new Set(claves).size).toBe(claves.length);
  });

  it("CLAVES_DE_DATO no tiene documentos", () => {
    expect(CLAVES_DE_DATO).toEqual(expect.arrayContaining(["dni", "dni_asegurado", "patente_vehiculo"]));
    expect(CLAVES_DE_DATO).not.toContain("fotos_danos");
    for (const clave of CLAVES_DE_DATO) expect(labelForField(clave).kind, clave).toBe("dato");
  });
});
