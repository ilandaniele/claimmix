/**
 * El SQL de `src/server/metrics/trayecto.ts`, renderizado sin base.
 *
 * Ejecutarlo contra datos y mirar el plan lo hace `pnpm load` (`explainPlans`).
 * Acá se afirma lo que se rompe en silencio: que los eventos vayan como literales (si van como
 * parámetros Postgres no puede usar el índice parcial), que el cruce con la
 * auditoría compare el id del caso como texto, que las ventanas estén en el
 * orden en que hace falta, y que no se cuente dos veces el mismo mail.
 */

vi.mock("server-only", () => ({}));

import { describe, it, expect, vi } from "vitest";
import { sql as plantilla } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { EVENTOS_CON_ESTADO, EVENTOS_DE_TRAYECTO } from "@/core/metricas/transiciones";
import { EVENTOS_DE_INTERVENCION } from "@/core/metricas/intervencion";
import {
  CON_ESTADO,
  DEL_CASO,
  HACIA,
  NO_ES_INTERMEDIO,
  SE_APLICO,
  consultaDeCiclo,
  consultaDeCuellos,
  consultaDeHistorial,
  literales,
} from "@/server/metrics/trayecto";

const DESDE = "2026-09-01T03:00:00.000Z";
const HASTA = "2026-10-01T03:00:00.000Z";

const armar = (consulta: (db: never, d: string, h: string) => { toSQL(): { sql: string; params: unknown[] } }) =>
  consulta(new QueryBuilder() as never, DESDE, HASTA).toSQL();

describe("literales", () => {
  it("escribe los nombres entre comillas simples, separados por coma", () => {
    const { sql: texto, params } = new PgDialect().sqlToQuery(plantilla`x in (${literales(["a", "b.c", "d_e"])})`);

    expect(texto).toBe("x in ('a', 'b.c', 'd_e')");
    expect(params).toEqual([]);
  });

  it("rechaza lo que no sea un nombre de evento o de estado", () => {
    for (const malo of ["x'; drop table cases; --", "Mayus", "con espacio", "a,b", "", "1"]) {
      expect(() => literales([malo]), malo).toThrow(/Nombre inválido/);
    }
  });
});

describe("consultaDeCiclo", () => {
  const { sql, params } = armar(consultaDeCiclo);

  it("los eventos van escritos en el texto, no como parámetros", () => {
    for (const e of [...EVENTOS_CON_ESTADO, ...EVENTOS_DE_INTERVENCION]) {
      expect(sql, e).toContain(`'${e}'`);
    }
    // El único evento que viaja como parámetro es el de `completadoConfirmado`,
    // que es de otra consulta y no toca el índice del trayecto.
    expect(params.filter((p) => EVENTOS_DE_TRAYECTO.includes(String(p)))).toEqual(["case.ready_confirmed"]);
  });

  it("el rango viaja como parámetro y nada del trayecto se agrega desde afuera", () => {
    expect(params).toEqual(["case.ready_confirmed", DESDE, HASTA]);
  });

  it("cruza la auditoría con el caso comparando el id como texto y el inquilino", () => {
    expect(sql).toContain(`a.target_id = "cases"."id"::text`);
    expect(sql).toContain(`a.tenant_id = "cases"."tenant_id"`);
    expect(sql).toContain(`a.target_type = 'case'`);
  });

  it("mide sólo reclamos de canales reales, sin simulaciones", () => {
    expect(sql).toContain(`"cases"."channel" in ('whatsapp', 'email', 'web')`);
    expect(sql).toContain(`"cases"."is_claim" is true`);
    expect(sql).not.toMatch(/_sim/);
  });

  it("la mediana es percentile_cont(0.5) y sólo cuenta los casos que llegaron", () => {
    expect(sql).toContain("percentile_cont(0.5) within group");
    expect(sql).toMatch(/filter \(where x\.t_listo is not null\)/);
    expect(sql).toContain("x.status in ('pagado', 'rechazado') and x.closed_at is not null");
  });

  it("ignora los eventos de Core que avisan que el estado NO se movió", () => {
    expect(sql).toContain(`(a.payload->>'status_not_applied') is distinct from 'true'`);
  });

  it("lee el estado con las dos claves que usan los escritores", () => {
    expect(sql).toContain(`coalesce(a.payload->>'new_status', a.payload->>'to')`);
  });

  it("una intervención cuenta sólo con actor y a lo sumo en el instante de listo", () => {
    expect(sql).toContain("a.actor_id is not null and a.created_at <= l.t_listo");
  });

  it("los mensajes suman los del caso y sólo los de WhatsApp enviados: el mail no se cuenta dos veces", () => {
    expect(sql).toContain(`o.channel = 'whatsapp' and o.status = 'sent'`);
    expect(sql).toContain(`from "claim_messages" m where m.case_id = "cases"."id"`);
  });

  it("del mail sólo cuentan los que llegaron o salieron: uno en cola o fallido no es un mensaje", () => {
    expect(sql).toContain(`m.status in ('received', 'sent')`);
  });
});

describe("consultaDeHistorial", () => {
  const { sql, params } = armar(consultaDeHistorial);

  it("agrupa por el mes de apertura en hora argentina y ordena por mes", () => {
    expect(sql).toContain(`to_char(date_trunc('month', x.created_at at time zone $`);
    expect(sql).toMatch(/group by 1 order by 1$/);
    expect(params).toContain("America/Argentina/Buenos_Aires");
  });

  it("completados, escalados y cerrados salen del estado de hoy", () => {
    expect(sql).toContain("count(*) filter (where x.completado)");
    expect(sql).toContain("x.status in ('escalado', 'requiere_especialista')");
    expect(sql).toContain("x.status in ('cerrado', 'pagado', 'rechazado')");
  });

  it("trae los mismos agregados que el ciclo: la pantalla y el CSV cuentan igual", () => {
    for (const parte of ["percentile_cont(0.5)", "avg(x.mensajes)", "count(x.t_listo)", "filter (where x.solo)"]) {
      expect(sql, parte).toContain(parte);
    }
  });
});

describe("consultaDeCuellos", () => {
  const { sql, params } = armar(consultaDeCuellos);

  it("las capas se anidan en el orden que necesita cada ventana: promedio, lead, lag, cambios", () => {
    const promedio = sql.indexOf("avg(extract(epoch");
    const lead = sql.indexOf("lead(t)");
    const lag = sql.indexOf("lag(estado)");
    const cambios = sql.indexOf("cross join lateral");

    expect(promedio).toBeGreaterThanOrEqual(0);
    expect(lead).toBeGreaterThan(promedio);
    expect(lag).toBeGreaterThan(lead);
    expect(cambios).toBeGreaterThan(lag);
  });

  it("los repetidos se quitan en el mismo nivel que el lead, y el lag corre un nivel más adentro", () => {
    // El WHERE de un SELECT corre antes que sus ventanas: así el lead salta las
    // filas repetidas y no acorta la estadía real. El lag, en cambio, tiene que
    // verlas todas, por eso está en la capa de abajo.
    const lead = sql.indexOf("lead(t)");
    const lag = sql.indexOf("lag(estado)");
    const filtro = sql.indexOf("where previo is distinct from estado");

    expect(lead).toBeLessThan(lag);
    expect(lag).toBeLessThan(filtro);
  });

  it("ordena por caso y por instante, con el id del evento como desempate", () => {
    expect(sql).toContain("over (partition by caso order by t, evento)");
  });

  it("sólo las estadías que ya terminaron, ordenadas de mayor a menor", () => {
    expect(sql).toContain("where estadias.hasta is not null");
    expect(sql).toMatch(/group by 1 order by 2 desc$/);
  });

  it("excluye el `listo` intermedio de la extracción", () => {
    expect(sql).toContain(
      `not (a.event_type = 'ai.extraction_complete' and a.payload->>'new_status' = 'listo')`
    );
  });

  it("el rango es lo único que viaja como parámetro", () => {
    expect(params).toEqual([DESDE, HASTA]);
  });

  it("mantiene el lateral parametrizado: `offset 0` justo antes de cerrarlo", () => {
    // Sin la valla Postgres lo aplana en un Hash Join sobre todo idx_audit_log_trayecto
    // (uuid_out no es leakproof y bajo RLS no se empuja al índice): 25-45 ms en vez de 0,5.
    expect(sql).toMatch(/is not null\s+offset 0\s*\)\s*e\b/);
    expect(sql.match(/offset 0/g)).toHaveLength(1);
  });

  it("la valla no se contagia a las otras consultas ni a los fragmentos compartidos", () => {
    expect(armar(consultaDeCiclo).sql).not.toMatch(/offset/);
    expect(armar(consultaDeHistorial).sql).not.toMatch(/offset/);
    for (const f of [CON_ESTADO, HACIA, SE_APLICO, NO_ES_INTERMEDIO, DEL_CASO]) {
      expect(new PgDialect().sqlToQuery(plantilla`${f}`).sql).not.toMatch(/offset/);
    }
  });
});
