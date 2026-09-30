/**
 * Lo que la extracción le suma al caso para el equipo (B9, B10, B13): el
 * puntaje de complejidad, el vencimiento que corre desde que entró y los
 * criterios que viajan al orquestador. Todo sale del SELECT del caso y de lo
 * que el modelo devolvió; nada de eso va a lo que lee el asegurado.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { filaDeCaso, registrarMocks, type FilaDeCaso, type OpcionesDelExtractor } from "./worker-harness";

// Con fecha de creación el turno del mail hace su propio SELECT y le comería al
// arnés el segundo lugar, que es el del mensaje crudo.
vi.mock("@/server/intake/simulation-throttle", () => ({
  waitForEmailExtractionTurn: vi.fn().mockResolvedValue({ waitedMs: 0, timedOut: false, blockers: 0 }),
}));

const CASE_ID = "trabajo-test-0000-0000-000000000001";
const TENANT_ID = "trabajo-test-0000-0000-000000000002";
const ANA = "11111111-1111-4111-8111-111111111111";

const dialecto = new PgDialect();

async function correr(
  fila: Partial<FilaDeCaso> = {},
  extractor: OpcionesDelExtractor = {},
  guardado: { guardados?: Record<string, string>; guardadosFallan?: boolean } = {}
) {
  vi.resetModules();
  const espiaDeUpdate = vi.fn<(data: Record<string, unknown>) => void>();
  const { mockDb } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, fila),
    espiaDeUpdate,
    extractor,
    ...guardado,
  });
  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const escrito = espiaDeUpdate.mock.calls.map((c) => c[0]).find((d) => "monto_estimado" in d) ?? {};
  const columnas = mockDb.select.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown> | undefined)
    .find((c: Record<string, unknown> | undefined) => c && "reglas_asignacion" in c);
  const columnasDeCampos = mockDb.select.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown> | undefined)
    .filter((c): c is Record<string, unknown> => !!c && "field_key" in c && "field_value" in c);
  const sqlDe = (x: unknown) => dialecto.sqlToQuery(x as SQL);
  // El puntaje viaja como parámetro dentro del CASE que lo protege de un presupuesto que entró a último momento.
  const puntajeDe = (d: Record<string, unknown>) =>
    sqlDe(d.puntaje_complejidad).params.find((p): p is number => typeof p === "number");
  return { escrito, columnas, columnasDeCampos, sqlDe, puntajeDe, orquestador: vi.mocked(orchestratePostExtraction) };
}

afterEach(() => vi.restoreAllMocks());

describe("runEmailExtractionWorker — lo que es del equipo", () => {
  it("lee la configuración del inquilino en el mismo SELECT del caso", async () => {
    const { columnas, sqlDe } = await correr();

    expect(sqlDe(columnas!.reglas_asignacion).sql).toBe(
      '(select "tenants"."reglas_asignacion" from "tenants" where "tenants"."id" = "cases"."tenant_id")'
    );
    expect(sqlDe(columnas!.plazos_propios).sql).toContain('"tenants"."plazos"');
    expect(sqlDe(columnas!.plan_por_tipo).sql).toContain('"tenants"."plan_por_tipo"');
    expect(sqlDe(columnas!.pesos_puntaje).sql).toContain('"tenants"."pesos_puntaje"');
  });

  it("escribe el puntaje con los pesos del inquilino", async () => {
    const pesos = { severidad: 100, fraude: 0, lesiones: 0, monto: { peso: 0, umbral: { bajo: 1, alto: 2 } }, campos: [] };
    const { escrito, puntajeDe } = await correr({ pesos_puntaje: pesos });

    // La gravedad del mock es «medium»: la mitad del peso.
    expect(puntajeDe(escrito)).toBe(50);
  });

  it("sin pesos propios rigen los de por defecto, y uno que no valida no rompe nada", async () => {
    const { escrito: sinPesos, puntajeDe } = await correr();
    const { escrito: rotos } = await correr({ pesos_puntaje: { severidad: "mucho" } });

    expect(puntajeDe(sinPesos)).toBe(21);
    expect(puntajeDe(rotos)).toBe(21);
  });

  describe("los campos propios cuentan con lo guardado, no con lo que leyó el modelo", () => {
    const pesosConFecha = {
      severidad: 0,
      fraude: 0,
      lesiones: 0,
      monto: { peso: 0, umbral: { bajo: 1, alto: 2 } },
      campos: [{ clave: "fecha_siniestro", puntos: 100 }],
    };
    const conFecha = {
      extracted_fields_extra: { accident_date: "2026-09-20" },
      fields: [{ field_key: "accident_date", field_value: "2026-09-20", confidence: 0.9, source: "ai" }],
    };

    it("el alias de los pesos encuentra la clave canónica que quedó guardada", async () => {
      const c = await correr({ pesos_puntaje: pesosConFecha }, conFecha, { guardados: { accident_date: "2026-09-20" } });
      const sin = await correr({ pesos_puntaje: pesosConFecha });

      expect(c.puntajeDe(c.escrito)).toBe(100);
      expect(sin.puntajeDe(sin.escrito)).toBe(0);
    });

    it("lee los campos guardados en una sola consulta, y sólo dos columnas", async () => {
      const { columnasDeCampos } = await correr({ pesos_puntaje: pesosConFecha }, conFecha, {
        guardados: { accident_date: "2026-09-20" },
      });

      expect(columnasDeCampos).toHaveLength(1);
      expect(Object.keys(columnasDeCampos[0]!).sort()).toEqual(["field_key", "field_value"]);
    });

    it("sin campos ponderados no consulta nada", async () => {
      const { columnasDeCampos } = await correr({ pesos_puntaje: { ...pesosConFecha, campos: [] } }, conFecha);

      expect(columnasDeCampos).toHaveLength(0);
    });

    it("un valor que confirmó el analista no lo deshace lo que el modelo vuelve a leer en un mensaje nuevo", async () => {
      const pesos = { ...pesosConFecha, campos: [{ clave: "accident_date", valor: "2026-09-21", puntos: 100 }] };
      // El analista dejó 2026-09-21 con confianza 1.00; el modelo vuelve a leer 2026-09-20.
      const { puntajeDe, escrito } = await correr({ pesos_puntaje: pesos }, conFecha, {
        guardados: { accident_date: "2026-09-21" },
      });

      expect(puntajeDe(escrito)).toBe(100);
    });

    it("un campo que el modelo leyó con baja confianza y nunca se guardó no suma", async () => {
      const bajo = {
        extracted_fields_extra: { accident_date: "2026-09-20" },
        fields: [{ field_key: "accident_date", field_value: "2026-09-20", confidence: 0.4, source: "ai" }],
      };
      const { puntajeDe, escrito } = await correr({ pesos_puntaje: pesosConFecha }, bajo, { guardados: {} });

      expect(puntajeDe(escrito)).toBe(0);
    });

    it("si no se pudieron leer los campos guardados, el puntaje que hay queda como está", async () => {
      const { escrito } = await correr({ pesos_puntaje: pesosConFecha }, conFecha, { guardadosFallan: true });

      expect(escrito).not.toHaveProperty("puntaje_complejidad");
      // Lo demás del caso se escribe igual.
      expect(escrito).toHaveProperty("monto_estimado");
    });

    it("el valor exacto que piden los pesos también se compara contra lo guardado", async () => {
      const pesos = { ...pesosConFecha, campos: [{ clave: "accident_date", valor: "2026-09-20", puntos: 100 }] };
      const igual = await correr({ pesos_puntaje: pesos }, conFecha, { guardados: { accident_date: "2026-09-20" } });
      const otro = await correr({ pesos_puntaje: pesos }, conFecha, { guardados: { accident_date: "2026-09-25" } });

      expect(igual.puntajeDe(igual.escrito)).toBe(100);
      expect(otro.puntajeDe(otro.escrito)).toBe(0);
    });
  });

  it("el puntaje sólo se escribe si la base ve lo mismo que se leyó del presupuesto: si no, queda el guardado", async () => {
    const { escrito, sqlDe } = await correr();

    const q = sqlDe(escrito.puntaje_complejidad);
    expect(q.sql).toMatch(
      /^CASE WHEN coalesce\("cases"\."monto_estimado"->>'origen' = 'presupuesto' AND "cases"\."claim_type" IS NOT DISTINCT FROM \$1 AND "cases"\."severity" IS NOT DISTINCT FROM \$2, false\) = \$3::boolean THEN \$4::smallint ELSE "cases"\."puntaje_complejidad" END$/
    );
    // El mock no trae presupuesto: se calculó con el monto de la tabla.
    expect(q.params.slice(0, 3)).toEqual(["choque", "medium", false]);
  });

  it("con un presupuesto vigente en lo que se leyó, la condición espera que la base también lo vea vigente", async () => {
    const presupuesto = { minimo: 1, maximo: 300_000, moneda: "ARS", origen: "presupuesto" };
    const { escrito, sqlDe } = await correr({ claim_type: "choque", severity: "medium", monto_estimado: presupuesto });

    expect(sqlDe(escrito.puntaje_complejidad).params.slice(0, 3)).toEqual(["choque", "medium", true]);
  });

  it("un plazo anclado en la entrada corre desde que se creó el caso, sin pisar el que ya hay", async () => {
    const plazos = [{ clave: "contacto", titulo: "Primer contacto", dias: 2, ancla: "recibido" }];
    const { escrito, sqlDe } = await correr({ plazos_propios: plazos, created_at: "2026-09-29T15:00:00Z" });

    const vence = sqlDe(escrito.vence_en);
    expect(vence.sql).toBe(
      'CASE WHEN "cases"."vence_en" IS NULL THEN $1::timestamptz ELSE "cases"."vence_en" END'
    );
    expect(vence.params).toEqual(["2026-10-02T02:59:59.999Z"]);
    expect(sqlDe(escrito.vence_plazo).params).toEqual(["contacto"]);
  });

  it("sin plazos anclados en la entrada no toca el vencimiento", async () => {
    const { escrito } = await correr({ plazos_propios: [{ clave: "x", titulo: "X", dias: 5, ancla: "en_liquidacion" }] });

    expect(escrito).not.toHaveProperty("vence_en");
    expect(escrito).not.toHaveProperty("vence_plazo");
  });

  it("le pasa los criterios al orquestador como argumento aparte, ya validados", async () => {
    const reglas = { reglas: [{ tipos: ["choque"], personas: [ANA] }] };
    const { orquestador } = await correr({ reglas_asignacion: reglas, plan_por_tipo: { porTipo: 7 } });

    expect(orquestador).toHaveBeenCalledTimes(1);
    const [, , salida, , , criterios] = orquestador.mock.calls[0]!;
    expect(criterios).toEqual({ tipo: "choque", reglas, plazos: [], plan: null });
    // Nada de esto viaja dentro de lo extraído: es lo que el redactor lee.
    expect(JSON.stringify(salida)).not.toContain(ANA);
  });
});
