import { describe, expect, it } from "vitest";

import {
  AdjuntoLeidoSchema,
  DocumentoLeidoSchema,
  ExtractedClaimSchema,
  RESPUESTA_JSON_SCHEMA,
  TIPOS_DE_INDICIO,
} from "@/lib/schemas/extracted-claim";

const raiz = RESPUESTA_JSON_SCHEMA.json_schema.schema;
const orden = (xs: string[]) => [...xs].sort();

describe("RESPUESTA_JSON_SCHEMA sigue a ExtractedClaimSchema", () => {
  it("las mismas claves arriba, todas requeridas (parse_failed lo pone el código, no el modelo)", () => {
    const zod = Object.keys(ExtractedClaimSchema.shape).filter((k) => k !== "parse_failed");
    expect(orden(Object.keys(raiz.properties))).toEqual(orden(zod));
    expect(orden(raiz.required)).toEqual(orden(zod));
  });

  it("cada adjunto y su documento piden las mismas claves que valida Zod", () => {
    const item = raiz.properties.adjuntos.items;
    expect(orden(Object.keys(item.properties))).toEqual(orden(Object.keys(AdjuntoLeidoSchema.shape)));
    expect(orden(item.required)).toEqual(orden(Object.keys(AdjuntoLeidoSchema.shape)));
    expect(orden(item.properties.documento.required)).toEqual(
      orden(Object.keys(DocumentoLeidoSchema.shape))
    );
  });

  it("el enum de indicios del esquema es la lista cerrada", () => {
    expect(raiz.properties.fraud_indicators.items.properties.type.enum).toEqual([...TIPOS_DE_INDICIO]);
  });
});

describe("lo que el modelo devuelve mal de un adjunto no tira la extracción", () => {
  const base = { extraction_model: "m", fields: [], prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };

  it("un adjuntos que no es lista queda vacío", () => {
    expect(ExtractedClaimSchema.parse({ ...base, adjuntos: "no" }).adjuntos).toEqual([]);
  });

  it("un resumen de más de 200 queda vacío y un documento roto queda en null", () => {
    const r = ExtractedClaimSchema.parse({
      ...base,
      adjuntos: [{ indice: 1, resumen: "x".repeat(201), util: true, documento: { patente: 5 } }],
    });
    expect(r.adjuntos[0]).toMatchObject({ indice: 1, resumen: "", util: true });
    expect(r.adjuntos[0]!.documento).toMatchObject({ patente: null });
  });

  it("un tipo de indicio fuera de la lista no pasa", () => {
    const r = ExtractedClaimSchema.safeParse({
      ...base,
      fraud_indicators: [{ type: "inventado", description: "x" }],
    });
    expect(r.success).toBe(false);
  });
});
