/**
 * `?type=choque&type=robo`: los grupos de la bandeja pasan a multi-select.
 *
 * `CaseQuerySchema` recibe la lista tal como la arma `URLSearchParams` —
 * repetida, no separada por comas— y tiene que seguir aceptando lo que ya
 * andaba: un valor suelto sigue siendo un valor suelto para el resto del
 * código, y un bookmark viejo con un solo filtro no se rompe.
 */

import { describe, it, expect } from "vitest";

import { CaseQuerySchema } from "@/lib/schemas/cases";

describe("listaDe — status, type, severity, channel", () => {
  it("un valor suelto llega como lista de uno", () => {
    const result = CaseQuerySchema.safeParse({ status: "listo" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toEqual(["listo"]);
    }
  });

  it("varios valores se aceptan todos", () => {
    const result = CaseQuerySchema.safeParse({ type: ["choque", "robo"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toEqual(["choque", "robo"]);
    }
  });

  it("vacío da undefined, no un array vacío", () => {
    expect(CaseQuerySchema.safeParse({ severity: "" }).success).toBe(true);
    expect(CaseQuerySchema.safeParse({ severity: "" }).data?.severity).toBeUndefined();
    expect(CaseQuerySchema.safeParse({ severity: [] }).data?.severity).toBeUndefined();
  });

  it("ausente da undefined", () => {
    const result = CaseQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.channel).toBeUndefined();
    }
  });

  it("un inválido entre válidos rechaza el parámetro entero", () => {
    // Igual que hoy con uno solo: `?status=invalid` es un 400, no un filtro
    // que ignora lo que no entiende.
    const result = CaseQuerySchema.safeParse({
      channel: ["email", "invalido"],
    });
    expect(result.success).toBe(false);
  });

  it("is_claim sigue siendo uno solo", () => {
    // Sus dos opciones son complementarias: una lista no tendría sentido.
    const result = CaseQuerySchema.safeParse({ is_claim: "true" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_claim).toBe(true);
    }

    expect(CaseQuerySchema.safeParse({ is_claim: ["true", "false"] }).success).toBe(
      false
    );
  });
});
