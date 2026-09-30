/**
 * Lo que acompaña al UPDATE de estado (B9, B10, B11). No hay base: se mira el
 * SQL que arma cada efecto, porque la decisión la toma la base y la garantía
 * está en cómo se acota cada sentencia.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { Reglas } from "@/core/case/asignacion";
import type { ClienteDatos } from "@/data/scope";
import * as schema from "@/lib/db/schema";
import {
  ajusteDeVencimiento,
  consultaDeCarga,
  criteriosDeTrabajo,
  efectosDeTransicion,
  type CriteriosDeTrabajo,
} from "@/server/cases/efectos-de-transicion";

// Arma las consultas sin conectarse: nadie las espera.
const db = drizzle(neon("postgres://u:p@localhost/db"), { schema }) as unknown as ClienteDatos;
const dialecto = new PgDialect();
const sqlDe = (q: unknown) => dialecto.sqlToQuery((q as { getSQL(): never }).getSQL());

const CASO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "22222222-2222-4222-8222-222222222222";
const ACTOR = "99999999-9999-4999-8999-999999999999";

const REGLAS: Reglas = { reglas: [{ tipos: ["choque"], personas: [ANA, BETO] }] };
const criterios = (c: Partial<CriteriosDeTrabajo> = {}): CriteriosDeTrabajo => ({
  tipo: "choque",
  reglas: REGLAS,
  plazos: [],
  plan: null,
  ...c,
});

const efectos = (hacia: Parameters<typeof efectosDeTransicion>[1]["hacia"], origen: "agente" | "persona", c = criterios()) =>
  efectosDeTransicion(db, { caseId: CASO, hacia, origen, actorId: origen === "persona" ? ACTOR : null, criterios: c }).map(sqlDe);

describe("efectosDeTransicion", () => {
  it("el agente al llegar a listo_para_core asigna, arma el plan y no tilda nada", () => {
    const [asigna, plan, ...resto] = efectos("listo_para_core", "agente");
    expect(resto).toEqual([]);
    expect(asigna!.sql).toContain("UPDATE cases c SET assigned_to");
    expect(asigna!.sql).toContain("c.assigned_to IS NULL");
    expect(asigna!.params).toEqual(expect.arrayContaining([ANA, BETO, "case.assigned"]));
    expect(plan!.sql).toContain("INSERT INTO case_plan_pasos");
    expect(plan!.sql).toContain("ON CONFLICT (case_id, clave) DO NOTHING");
  });

  it("un caso que ya tiene plan no recibe otro: el INSERT pide que no haya ningún paso", () => {
    const [, plan] = efectos("listo_para_core", "agente");
    expect(plan!.sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM case_plan_pasos x WHERE x\.case_id = c\.id\)/);
  });

  it("si la primera regla se quedó sin quien edite, la base sigue con la que viene y audita la de quien tomó el caso", () => {
    const reglas: Reglas = { reglas: [{ tipos: ["choque"], personas: [ANA] }, { personas: [BETO] }] };
    const [asigna] = efectos("listo_para_core", "agente", criterios({ reglas }));
    const candidatas = JSON.parse(asigna!.params.find((p) => typeof p === "string" && p.startsWith("[{")) as string);
    expect(candidatas).toEqual([
      { persona: ANA, regla: 0 },
      { persona: BETO, regla: 1 },
    ]);
    expect(asigna!.params).toEqual(expect.arrayContaining([ANA, BETO]));
    expect(asigna!.sql).toMatch(/ORDER BY c\.regla, k\.abiertos, k\.full_name, k\.id LIMIT 1/);
    expect(asigna!.sql).toContain("(SELECT regla FROM carga) AS regla");
    expect(asigna!.sql).toContain("'regla', regla");
  });

  it("en requiere_especialista el agente sólo asigna: el plan empieza más adelante", () => {
    const todo = efectos("requiere_especialista", "agente");
    expect(todo).toHaveLength(1);
    expect(todo[0]!.sql).toContain("SET assigned_to");
  });

  it("una persona que cambia el estado no dispara la autoasignación", () => {
    const todo = efectos("listo_para_core", "persona");
    expect(todo).toHaveLength(1);
    expect(todo[0]!.sql).toContain("INSERT INTO case_plan_pasos");
    expect(efectos("requiere_especialista", "persona")).toEqual([]);
  });

  it("sin reglas, o sin una que coincida con el tipo, no asigna", () => {
    expect(efectos("listo_para_core", "agente", criterios({ reglas: null }))).toHaveLength(1);
    expect(efectos("requiere_especialista", "agente", criterios({ tipo: "robo" }))).toEqual([]);
    expect(efectos("requiere_especialista", "agente", criterios({ tipo: null }))).toEqual([]);
  });

  it("al entrar a en_liquidacion arma el plan que no tenía y tilda los pasos de ese estado", () => {
    const [plan, tilda, ...resto] = efectos("en_liquidacion", "persona");
    expect(resto).toEqual([]);
    expect(plan!.sql).toContain("INSERT INTO case_plan_pasos");
    expect(tilda!.sql).toContain("UPDATE case_plan_pasos SET hecho_en = now()");
    expect(tilda!.sql).toContain("hecho_en IS NULL");
    expect(tilda!.params).toEqual(expect.arrayContaining(["en_liquidacion", ACTOR, "case.plan_step"]));
  });

  it("pagado sólo tilda: el plan ya existe", () => {
    const todo = efectos("pagado", "persona");
    expect(todo).toHaveLength(1);
    expect(todo[0]!.sql).toContain("UPDATE case_plan_pasos");
    expect(todo[0]!.params).toContain("pagado");
  });

  it("los estados que el agente recorre antes de estar listo no tienen efectos", () => {
    for (const hacia of ["confirmacion_pendiente", "info_faltante", "procesando", "cerrado", "rechazado"] as const) {
      expect(efectos(hacia, "agente")).toEqual([]);
    }
  });

  it("cada efecto se acota al caso y a lo que tocó esta transacción, sin filtro por inquilino", () => {
    for (const hacia of ["listo_para_core", "en_liquidacion", "pagado"] as const) {
      for (const s of efectos(hacia, "agente")) {
        expect(s.sql).toContain("updated_at = now()");
        expect(s.sql).toMatch(/status = \$\d+::text/);
        expect(s.params).toContain(CASO);
        expect(s.sql).not.toMatch(/tenant_id\s*=/);
      }
    }
  });

  it("la auditoría de la asignación automática queda sin actor y dice la regla", () => {
    const [asigna] = efectos("listo_para_core", "agente");
    expect(asigna!.sql).toMatch(/SELECT tenant_id, NULL::uuid, \$\d+::text, 'case'/);
    expect(asigna!.sql).toContain("'auto', true");
    expect(asigna!.sql).toContain("'regla'");
  });

  it("el plan lleva los pasos por defecto del tipo en su orden, con el título copiado", () => {
    const [, plan] = efectos("listo_para_core", "agente");
    const pasos = JSON.parse(plan!.params.find((p) => typeof p === "string" && p.startsWith("[")) as string) as {
      clave: string;
      orden: number;
      auto: string | null;
    }[];
    expect(pasos.map((p) => p.clave)).toEqual([
      "revisar_documentacion",
      "verificar_cobertura",
      "revisar_presupuesto",
      "definir_responsabilidad",
      "entregar_a_aseguradora",
      "confirmar_pago",
    ]);
    expect(pasos.map((p) => p.orden)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pasos.at(-1)!.auto).toBe("pagado");
  });

  it("un plan propio de la aseguradora reemplaza al de por defecto", () => {
    const propio = { porTipo: { choque: [{ clave: "llamar", titulo: "Llamar al taller" }] } };
    const [, plan] = efectos("listo_para_core", "agente", criterios({ plan: propio }));
    const json = plan!.params.find((p) => typeof p === "string" && p.startsWith("[")) as string;
    expect(JSON.parse(json)).toEqual([{ clave: "llamar", titulo: "Llamar al taller", orden: 0, auto: null }]);
  });
});

describe("consultaDeCarga", () => {
  it("cuenta los casos abiertos por persona que edita, de menos a más y desempata por nombre e id", () => {
    const q = sqlDe(consultaDeCarga(db));
    expect(q.sql).toContain('left join "cases" on');
    expect(q.sql).toContain('"cases"."status" not in');
    expect(q.sql).toContain('"users"."role" in');
    expect(q.sql).toMatch(/order by count\("cases"."id"\), "users"."full_name", "users"."id"/);
    expect(q.params).toEqual(expect.arrayContaining(["cerrado", "pagado", "rechazado", "owner", "admin", "specialist", "analyst"]));
    expect(q.params).not.toContain("viewer");
  });

  it("acota al pool cuando se le pasa uno", () => {
    const q = sqlDe(consultaDeCarga(db, [ANA, BETO]));
    expect(q.params).toEqual(expect.arrayContaining([ANA, BETO]));
  });
});

describe("ajusteDeVencimiento", () => {
  const AHORA = new Date("2026-09-29T15:00:00Z");
  const con = (hacia: Parameters<typeof ajusteDeVencimiento>[0], c = criterios()) => ajusteDeVencimiento(hacia, c, AHORA);

  it("listo_para_core fija el art. 56 a 30 días, al final del día argentino", () => {
    const a = con("listo_para_core");
    const vence = sqlDe(a.vence_en);
    expect(vence.params).toContain("2026-10-30T02:59:59.999Z");
    expect(sqlDe(a.vence_plazo).params).toContain("art56");
  });

  it("repetir la transición, o volver de error_core, conserva el vencimiento que corría", () => {
    const vence = sqlDe(con("listo_para_core").vence_en);
    expect(vence.sql).toMatch(/"cases"\."vence_en" IS NOT NULL AND \("cases"\."status" IN \(\$\d+, 'error_core'\) OR /);
    expect(vence.sql).toContain('THEN "cases"."vence_en" ELSE');
    expect(vence.params).toContain("listo_para_core");
  });

  it("re-analizar un caso que ya corría su plazo no lo reinicia: alcanza con que el plazo sea el mismo", () => {
    // Re-analizar pasa por procesando y listo: el estado previo ya no es listo_para_core.
    const a = con("listo_para_core");
    const vence = sqlDe(a.vence_en);
    const plazo = sqlDe(a.vence_plazo);
    expect(vence.sql).toMatch(/OR "cases"\."vence_plazo" = \$\d+::text\) THEN "cases"\."vence_en" ELSE/);
    expect(plazo.sql).toMatch(/OR "cases"\."vence_plazo" = \$\d+::text\) THEN "cases"\."vence_plazo" ELSE/);
    // La comparación es con el plazo que fijaría esta entrada, y el nuevo sigue siendo el ELSE.
    expect(vence.params.filter((x) => x === "art56")).toHaveLength(1);
    expect(vence.params).toContain("2026-10-30T02:59:59.999Z");
  });

  it("un plazo propio se conserva por su clave, no sólo el art. 56", () => {
    const a = con(
      "listo_para_core",
      criterios({ plazos: [{ clave: "interno", titulo: "Interno", dias: 10, ancla: "listo_para_core" }] })
    );
    expect(sqlDe(a.vence_en).params.filter((x) => x === "interno")).toHaveLength(1);
    expect(sqlDe(a.vence_en).sql).toMatch(/"cases"\."vence_plazo" = \$\d+::text/);
  });

  it("pasar de error_core a en_liquidacion no conserva el art. 56: sólo el reintento a listo_para_core lo hace", () => {
    const propio = criterios({ plazos: [{ clave: "pago", titulo: "Pago", dias: 15, ancla: "en_liquidacion" }] });
    const enLiquidacion = sqlDe(con("en_liquidacion", propio).vence_en);
    expect(enLiquidacion.sql).toMatch(/"cases"\."vence_en" IS NOT NULL AND \("cases"\."status" = \$\d+ OR /);
    expect(enLiquidacion.sql).not.toContain("error_core");
    expect(sqlDe(con("listo_para_core").vence_en).sql).toContain("'error_core'");
  });

  it("un estado terminal lo limpia", () => {
    expect(con("cerrado")).toEqual({ vence_en: null, vence_plazo: null });
    expect(con("pagado")).toEqual({ vence_en: null, vence_plazo: null });
  });

  it("los estados sin ancla no lo tocan", () => {
    expect(con("info_faltante")).toEqual({});
    expect(con("requiere_especialista")).toEqual({});
  });

  it("un plazo propio más corto que el legal gana", () => {
    const a = con(
      "listo_para_core",
      criterios({ plazos: [{ clave: "interno", titulo: "Interno", dias: 10, ancla: "listo_para_core" }] })
    );
    expect(sqlDe(a.vence_plazo).params).toContain("interno");
  });
});

describe("criteriosDeTrabajo", () => {
  it("sin configurar no hay reglas ni plan ni plazos", () => {
    expect(criteriosDeTrabajo({ reglas_asignacion: null, plazos_propios: null, plan_por_tipo: null }, "robo")).toEqual({
      tipo: "robo",
      reglas: null,
      plazos: [],
      plan: null,
    });
  });

  it("una configuración guardada que no valida se ignora, no rompe", () => {
    const c = criteriosDeTrabajo(
      { reglas_asignacion: { reglas: [{ personas: ["x"] }] }, plazos_propios: [{ clave: "art46" }], plan_por_tipo: { porTipo: {} , otra: 1 } },
      null
    );
    expect(c).toEqual({ tipo: null, reglas: null, plazos: [], plan: null });
  });

  it("una válida pasa tal cual", () => {
    expect(criteriosDeTrabajo({ reglas_asignacion: REGLAS, plazos_propios: [], plan_por_tipo: null }, "choque").reglas).toEqual(REGLAS);
  });
});
