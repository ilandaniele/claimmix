/**
 * El número de póliza que la persona escribió no se acorta.
 *
 * El ensayo `mail-que-no-coincide-con-el-padron` dice «La póliza es POL-3390-F» y
 * el modelo devolvía `policy_number: "3390"` en 4 de 4 corridas, a veces con
 * `numero_poliza: "POL-3390-F"` al lado. La clave canónica gana en
 * `canonizarCampos`, el buscador de pólizas comparaba «3390» contra
 * «POL-3390-F» y daba cero: el worker no sabía que quien escribía no era el
 * titular, y el caso terminaba pidiendo patente y provincia o derivaba sólo si
 * el modelo lo deliberaba ese día (rojo 7 de 11 veces).
 */

import { describe, it, expect } from "vitest";
import { anclarPolizaAlTexto, parseEmailClaimFields } from "@/lib/email/claim-parser";
import { canonizarCampos } from "@/core/case/campos-canonicos";
import { CLAIM_FIELD_KEYS } from "@/lib/schemas/extracted-claim";
import { extraccion } from "../helpers/extraccion";

const TEXTO = "Escribo por el auto de mi viejo. La póliza es POL-3390-F. Soy Lucía Paz.";

function poliza(campos: Array<{ key: string; value: string; confidence?: number }>, tipada?: string) {
  return extraccion({
    extraction_model: "fixture",
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    fields: campos.map((c) => ({
      field_key: c.key,
      field_value: c.value,
      confidence: c.confidence ?? 0.8,
      source: "ai" as const,
    })),
    ...(tipada && {
      extracted_fields: { policy_number: tipada },
      field_confidences: { policy_number: 0.8 },
    }),
  });
}

describe("parseEmailClaimFields — la póliza dicha sin dos puntos", () => {
  const numero = (body: string) =>
    parseEmailClaimFields({ subject: "", body, senderEmail: null }).find(
      (f) => f.field_key === "policy_number"
    )?.field_value ?? null;

  it("lee «la póliza es POL-3390-F»", () => {
    expect(numero(TEXTO)).toBe("POL-3390-F");
  });

  it("lee «póliza n° POL-3390-F» y «póliza POL-3390-F»", () => {
    expect(numero("Mi póliza n° POL-3390-F, gracias")).toBe("POL-3390-F");
    expect(numero("Tengo la póliza POL-3390-F al día")).toBe("POL-3390-F");
  });

  it("sin un dígito no es un número: «póliza vencida» no se guarda", () => {
    expect(numero("Mi póliza vencida hace poco, ¿me cubren?")).toBeNull();
    expect(numero("La póliza es de mi papá")).toBeNull();
  });

  it("con dos puntos sigue igual", () => {
    expect(numero("Póliza: POL-3390-F")).toBe("POL-3390-F");
  });
});

describe("anclarPolizaAlTexto", () => {
  it("un pedazo del número escrito vuelve entero, en la tipada y en fields[]", () => {
    const claim = poliza(
      [
        { key: "policy_number", value: "3390" },
        { key: "numero_poliza", value: "3390" },
      ],
      "3390"
    );

    const anclada = anclarPolizaAlTexto(claim, TEXTO);

    expect(anclada.extracted_fields?.policy_number).toBe("POL-3390-F");
    expect(anclada.fields.map((f) => f.field_value)).toEqual(["POL-3390-F", "POL-3390-F"]);
    // La persona lo escribió tal cual: vale lo que el parser le da al número escrito.
    expect(anclada.fields[0].confidence).toBeGreaterThanOrEqual(0.86);
    expect(anclada.field_confidences.policy_number).toBeGreaterThanOrEqual(0.86);
  });

  it("lo que le llega al buscador es el número entero aunque la tipada diga «3390»", () => {
    const claim = poliza(
      [
        { key: "policy_number", value: "3390" },
        { key: "numero_poliza", value: "POL-3390-F" },
      ],
      "3390"
    );

    const anclada = anclarPolizaAlTexto(claim, TEXTO);
    const canonicos = canonizarCampos(anclada.fields, anclada.extracted_fields, CLAIM_FIELD_KEYS);

    expect(canonicos.policy_number).toBe("POL-3390-F");
  });

  it("un valor sin la clave canónica en fields[] también se completa", () => {
    const claim = poliza([{ key: "numero_poliza", value: "POL-3390" }]);

    expect(anclarPolizaAlTexto(claim, TEXTO).fields[0].field_value).toBe("POL-3390-F");
  });

  it("el número entero no se toca, ni su confianza", () => {
    const claim = poliza([{ key: "policy_number", value: "POL-3390-F", confidence: 0.95 }], "POL-3390-F");

    const anclada = anclarPolizaAlTexto(claim, TEXTO);

    expect(anclada.fields[0]).toEqual(claim.fields[0]);
    expect(anclada.extracted_fields?.policy_number).toBe("POL-3390-F");
    expect(anclada.field_confidences.policy_number).toBe(0.8);
  });

  it("otro número del modelo (no es un pedazo del escrito) no se pisa", () => {
    // La póliza salió de una foto: el texto dice otra cosa y el modelo eligió.
    const claim = poliza([{ key: "policy_number", value: "POL-7001-C" }], "POL-7001-C");

    const anclada = anclarPolizaAlTexto(claim, TEXTO);

    expect(anclada.fields[0].field_value).toBe("POL-7001-C");
    expect(anclada.extracted_fields?.policy_number).toBe("POL-7001-C");
  });

  it("un pedazo demasiado corto no cuenta", () => {
    const claim = poliza([{ key: "policy_number", value: "F" }], "F");

    expect(anclarPolizaAlTexto(claim, TEXTO).extracted_fields?.policy_number).toBe("F");
  });

  it("si el texto no dice ninguna póliza, devuelve lo mismo", () => {
    const claim = poliza([{ key: "policy_number", value: "3390" }], "3390");

    expect(anclarPolizaAlTexto(claim, "Choqué ayer en Belgrano al 1500.")).toBe(claim);
  });

  it("no toca los demás campos", () => {
    const claim = poliza(
      [
        { key: "policy_number", value: "3390" },
        { key: "dni", value: "41207663", confidence: 0.9 },
      ],
      "3390"
    );

    const anclada = anclarPolizaAlTexto(claim, TEXTO);

    expect(anclada.fields[1]).toEqual(claim.fields[1]);
  });
});
