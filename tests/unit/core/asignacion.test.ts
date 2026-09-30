/**
 * Quién recibe un caso según las reglas de la aseguradora (B9). El turno se
 * lee en hora argentina: a las 12:00Z son las 09:00 ART.
 */

import { describe, expect, it } from "vitest";

import { ReglasSchema, candidatasDeAsignacion, type Reglas } from "@/core/case/asignacion";

const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "22222222-2222-4222-8222-222222222222";
const CARLA = "33333333-3333-4333-8333-333333333333";

const pool = (reglas: Reglas | null, tipo: string | null, ahora: string) => candidatasDeAsignacion(reglas, { tipo, ahora: new Date(ahora) });

// lunes 28/09/2026
const LUNES_12Z = "2026-09-28T12:00:00Z";

describe("candidatasDeAsignacion", () => {
  it("sin reglas no elige a nadie", () => {
    expect(pool(null, "choque", LUNES_12Z)).toEqual([]);
    expect(pool({ reglas: [] }, "choque", LUNES_12Z)).toEqual([]);
  });

  it("una regla por tipo elige su pool", () => {
    const reglas: Reglas = { reglas: [{ tipos: ["robo"], personas: [ANA] }, { tipos: ["choque", "rc"], personas: [BETO, CARLA] }] };
    expect(pool(reglas, "robo", LUNES_12Z)).toEqual([{ persona: ANA, regla: 0 }]);
    expect(pool(reglas, "rc", LUNES_12Z)).toEqual([
      { persona: BETO, regla: 1 },
      { persona: CARLA, regla: 1 },
    ]);
    expect(pool(reglas, "granizo", LUNES_12Z)).toEqual([]);
    expect(pool(reglas, null, LUNES_12Z)).toEqual([]);
  });

  it("una regla sin tipos ni turno es el comodín", () => {
    expect(pool({ reglas: [{ personas: [ANA] }] }, null, LUNES_12Z)).toEqual([{ persona: ANA, regla: 0 }]);
  });

  it("las reglas que coinciden van en orden, y cada persona lleva la primera que la nombra", () => {
    const reglas: Reglas = {
      reglas: [{ tipos: ["choque"], personas: [ANA] }, { personas: [BETO, ANA] }, { tipos: ["choque"], personas: [CARLA] }],
    };
    expect(pool(reglas, "choque", LUNES_12Z)).toEqual([
      { persona: ANA, regla: 0 },
      { persona: BETO, regla: 1 },
      { persona: CARLA, regla: 2 },
    ]);
    expect(pool(reglas, "robo", LUNES_12Z)).toEqual([
      { persona: BETO, regla: 1 },
      { persona: ANA, regla: 1 },
    ]);
  });

  describe("turnos, en hora argentina", () => {
    const lunesDe9a18: Reglas = { reglas: [{ turno: { dias: [1], desde: "09:00", hasta: "18:00" }, personas: [ANA] }] };

    it("un turno de lunes de 9 a 18 ART toma el lunes a las 12:00Z (09:00 ART)", () => {
      expect(pool(lunesDe9a18, "choque", LUNES_12Z)).not.toEqual([]);
    });

    it("el borde de entrada es inclusivo y el de salida exclusivo", () => {
      expect(pool(lunesDe9a18, "choque", "2026-09-28T11:59:00Z")).toEqual([]);
      expect(pool(lunesDe9a18, "choque", "2026-09-28T20:59:00Z")).not.toEqual([]);
      expect(pool(lunesDe9a18, "choque", "2026-09-28T21:00:00Z")).toEqual([]);
    });

    it("otro día no entra", () => {
      expect(pool(lunesDe9a18, "choque", "2026-09-29T15:00:00Z")).toEqual([]);
    });

    it("el UTC no manda: el lunes 22:00 ART ya es martes en UTC", () => {
      const noche: Reglas = { reglas: [{ turno: { dias: [1], desde: "20:00", hasta: "23:00" }, personas: [ANA] }] };
      expect(pool(noche, "choque", "2026-09-29T01:00:00Z")).not.toEqual([]);
    });

    it("el domingo es el día 0", () => {
      const domingo: Reglas = { reglas: [{ turno: { dias: [0], desde: "00:00", hasta: "12:00" }, personas: [ANA] }] };
      expect(pool(domingo, "choque", "2026-09-27T14:00:00Z")).not.toEqual([]);
      expect(pool(domingo, "choque", "2026-09-28T15:00:00Z")).toEqual([]);
    });

    describe("un turno de 22 a 06 que cruza la medianoche", () => {
      const noche: Reglas = { reglas: [{ turno: { dias: [1], desde: "22:00", hasta: "06:00" }, personas: [ANA] }] };

      it("incluye las 23:30 del lunes y las 05:59 del martes, y excluye las 06:00", () => {
        expect(pool(noche, "choque", "2026-09-29T02:30:00Z")).not.toEqual([]); // lunes 23:30 ART
        expect(pool(noche, "choque", "2026-09-29T08:59:00Z")).not.toEqual([]); // martes 05:59 ART
        expect(pool(noche, "choque", "2026-09-29T09:00:00Z")).toEqual([]); // martes 06:00 ART
      });

      it("pertenece al día en que empieza: el martes de madrugada no rige el de martes", () => {
        const martes: Reglas = { reglas: [{ turno: { dias: [2], desde: "22:00", hasta: "06:00" }, personas: [ANA] }] };
        expect(pool(martes, "choque", "2026-09-29T08:59:00Z")).toEqual([]);
        expect(pool(martes, "choque", "2026-09-30T02:30:00Z")).not.toEqual([]);
      });

      it("el domingo de madrugada pertenece al turno que arrancó el sábado", () => {
        const sabado: Reglas = { reglas: [{ turno: { dias: [6], desde: "22:00", hasta: "06:00" }, personas: [ANA] }] };
        expect(pool(sabado, "choque", "2026-09-27T05:00:00Z")).not.toEqual([]); // domingo 02:00 ART
      });
    });

    it("un turno y un tipo se piden juntos", () => {
      const reglas: Reglas = { reglas: [{ tipos: ["robo"], turno: { dias: [1], desde: "09:00", hasta: "18:00" }, personas: [ANA] }] };
      expect(pool(reglas, "robo", LUNES_12Z)).not.toEqual([]);
      expect(pool(reglas, "choque", LUNES_12Z)).toEqual([]);
    });
  });
});

describe("ReglasSchema", () => {
  const regla = { personas: [ANA] };

  it("acepta una regla mínima y una completa", () => {
    expect(ReglasSchema.safeParse({ reglas: [regla] }).success).toBe(true);
    expect(
      ReglasSchema.safeParse({ reglas: [{ tipos: ["robo"], turno: { dias: [1, 2], desde: "09:00", hasta: "18:00" }, personas: [ANA, BETO] }] }).success
    ).toBe(true);
  });

  it("rechaza un uuid inválido y un pool vacío", () => {
    expect(ReglasSchema.safeParse({ reglas: [{ personas: ["no-es-uuid"] }] }).success).toBe(false);
    expect(ReglasSchema.safeParse({ reglas: [{ personas: [] }] }).success).toBe(false);
  });

  it("rechaza la hora 24:00, los turnos vacíos y los días fuera de 0 a 6", () => {
    const turno = (t: object) => ReglasSchema.safeParse({ reglas: [{ ...regla, turno: t }] }).success;
    expect(turno({ dias: [1], desde: "09:00", hasta: "24:00" })).toBe(false);
    expect(turno({ dias: [1], desde: "09:00", hasta: "09:00" })).toBe(false);
    expect(turno({ dias: [7], desde: "09:00", hasta: "18:00" })).toBe(false);
    expect(turno({ dias: [], desde: "09:00", hasta: "18:00" })).toBe(false);
  });

  it("rechaza claves y tipos desconocidos", () => {
    expect(ReglasSchema.safeParse({ reglas: [{ ...regla, otra: 1 }] }).success).toBe(false);
    expect(ReglasSchema.safeParse({ reglas: [{ ...regla, tipos: ["volcan"] }] }).success).toBe(false);
  });
});
