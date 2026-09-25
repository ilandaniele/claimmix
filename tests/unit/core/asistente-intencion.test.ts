/**
 * El contrato que le llega al modelo (`IntencionSchema`) y las cuentas de
 * fecha que corren aparte de la IA (`rangoDelPeriodo`).
 *
 * El modelo nunca decide la forma: si no la respeta exacto, `safeParse` lo
 * rechaza y `responder.ts` cae a "ninguna". Acá se prueba esa frontera.
 */

import { describe, it, expect } from "vitest";
import {
  IntencionSchema,
  PERIODOS,
  rangoDelPeriodo,
  textoDelConteo,
  type Periodo,
} from "@/core/asistente/intencion";

describe("IntencionSchema", () => {
  it("rechaza una herramienta que no está en la lista", () => {
    const r = IntencionSchema.safeParse({ herramienta: "borrar_caso" });
    expect(r.success).toBe(false);
  });

  it("rechaza una clave que no pertenece a la forma elegida", () => {
    // El modelo hostil agrega "tenant_id" o "sql" para intentar colarse.
    const r = IntencionSchema.safeParse({
      herramienta: "contar_casos",
      periodo: "hoy",
      canal: null,
      situacion: null,
      solo_reclamos: false,
      tenant_id: "otro-inquilino",
    });
    expect(r.success).toBe(false);
  });

  it("rechaza sql adentro de un campo de contar_casos", () => {
    const r = IntencionSchema.safeParse({
      herramienta: "contar_casos",
      periodo: "hoy",
      canal: null,
      situacion: null,
      solo_reclamos: false,
      sql: "DROP TABLE cases;",
    });
    expect(r.success).toBe(false);
  });

  it("un nombre con apariencia de SQL queda como texto plano, no ejecutable", () => {
    const r = IntencionSchema.safeParse({
      herramienta: "buscar_caso",
      nombre: "Roberto'; DROP TABLE cases; --",
      numero: null,
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.herramienta === "buscar_caso") {
      expect(r.data.nombre).toBe("Roberto'; DROP TABLE cases; --");
    }
  });

  it("acepta ninguna sin argumentos", () => {
    const r = IntencionSchema.safeParse({ herramienta: "ninguna" });
    expect(r.success).toBe(true);
  });

  it("rechaza un número con letras", () => {
    const r = IntencionSchema.safeParse({
      herramienta: "buscar_caso",
      nombre: null,
      numero: "POL-2024-01",
    });
    expect(r.success).toBe(false);
  });
});

describe("rangoDelPeriodo", () => {
  // Mediodía UTC del 15/09/2026, un martes: lejos de cualquier medianoche
  // en horario argentino (UTC-3), así que "hoy" no cruza de día por la zona.
  const ahora = new Date("2026-09-15T12:00:00.000Z");

  it.each(PERIODOS)("%s devuelve un rango con desde < hasta", (periodo: Periodo) => {
    const { desde, hasta } = rangoDelPeriodo(periodo, ahora);
    expect(new Date(desde).getTime()).toBeLessThan(new Date(hasta).getTime());
  });

  it("mes_pasado retrocede el año en enero", () => {
    const enero = new Date("2026-01-10T12:00:00.000Z");
    const { desde, hasta } = rangoDelPeriodo("mes_pasado", enero);
    expect(desde).toBe("2025-12-01T03:00:00.000Z");
    expect(hasta).toBe("2026-01-01T03:00:00.000Z");
  });

  it("hoy es la medianoche argentina de hoy hasta la de mañana", () => {
    const { desde, hasta } = rangoDelPeriodo("hoy", ahora);
    expect(desde).toBe("2026-09-15T03:00:00.000Z");
    expect(hasta).toBe("2026-09-16T03:00:00.000Z");
  });

  it("ayer es el día anterior a hoy", () => {
    const { desde, hasta } = rangoDelPeriodo("ayer", ahora);
    expect(desde).toBe("2026-09-14T03:00:00.000Z");
    expect(hasta).toBe("2026-09-15T03:00:00.000Z");
  });
});

describe("textoDelConteo", () => {
  it("arma la frase con período, canal, situación y reclamos", () => {
    const texto = textoDelConteo(
      { total: 7 },
      {
        herramienta: "contar_casos",
        periodo: "este_mes",
        canal: "whatsapp",
        situacion: "escalado",
        solo_reclamos: true,
      }
    );
    expect(texto).toContain("7");
    expect(texto).toContain("WhatsApp");
  });

  it("no pincha con todos los filtros en null", () => {
    const texto = textoDelConteo(
      { total: 0 },
      { herramienta: "contar_casos", periodo: "hoy", canal: null, situacion: null, solo_reclamos: false }
    );
    expect(texto).toContain("0");
  });
});
