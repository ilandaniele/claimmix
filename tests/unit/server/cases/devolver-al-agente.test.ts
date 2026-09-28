/**
 * `esDevolvible` — E24: el caso se devuelve sólo si lo último que le pasó fue
 * que alguien lo tomó con «Tomar el control».
 */

import { describe, it, expect } from "vitest";
import { esDevolvible } from "@/server/cases/devolver-al-agente";

describe("esDevolvible", () => {
  it("da false sin movimiento previo", () => {
    expect(esDevolvible(undefined)).toBe(false);
  });

  it("da true con case.status_changed, reason tomar_el_control, new_status requiere_especialista", () => {
    expect(
      esDevolvible({
        event_type: "case.status_changed",
        payload: { reason: "tomar_el_control", new_status: "requiere_especialista" },
      })
    ).toBe(true);
  });

  it("da false con otro evento (claim.specialist_required)", () => {
    expect(esDevolvible({ event_type: "claim.specialist_required", payload: {} })).toBe(false);
  });

  it("da false con case.status_changed pero otro motivo", () => {
    expect(
      esDevolvible({
        event_type: "case.status_changed",
        payload: { reason: "lesiones", new_status: "requiere_especialista" },
      })
    ).toBe(false);
  });

  it("da false con case.re_analyze_triggered (no es un cambio de estado)", () => {
    expect(esDevolvible({ event_type: "case.re_analyze_triggered", payload: {} })).toBe(false);
  });
});
