/**
 * La revisión nocturna (B22): cinco sentencias `INSERT … SELECT … ON CONFLICT
 * DO NOTHING`, una por regla, cada una aislada de las otras.
 *
 * El SQL no se ejecuta acá (no hay Postgres): se renderiza con el dialecto de
 * verdad y se comprueba su forma —qué tabla llena, cómo evita duplicar, qué
 * deja afuera, con qué plazos—. Que corra contra datos reales es lo que prueba
 * `pnpm check` en el deploy.
 */

vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({ execute: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: m.execute } }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: m.logError, warn: vi.fn(), info: vi.fn() },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { REGLAS, type Regla } from "@/core/desvios/reglas";
import { revisarDesvios } from "@/server/desvios/revision-nocturna";

const dialecto = new PgDialect();

type Consulta = { sql: string; params: unknown[] };
let consultas: Consulta[] = [];

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Contesta con las filas insertadas de cada regla, en el orden en que corren. */
function insertadas(...cuentas: Array<number | Error>) {
  consultas = [];
  m.execute.mockImplementation(async (q: SQL) => {
    const { sql, params } = dialecto.sqlToQuery(q);
    consultas.push({ sql: norm(sql), params });
    const c = cuentas[consultas.length - 1] ?? 0;
    if (c instanceof Error) throw c;
    return { rowCount: c };
  });
}

const de = (regla: Regla): Consulta => {
  const q = consultas.find((c) => c.sql.includes(`'${regla}'`));
  if (!q) throw new Error(`No corrió la regla ${regla}`);
  return q;
};

beforeEach(() => {
  vi.clearAllMocks();
  insertadas();
});

describe("revisarDesvios", () => {
  it("corre las cinco reglas, en el orden de REGLAS, una sentencia cada una", async () => {
    await revisarDesvios();

    expect(consultas).toHaveLength(REGLAS.length);
    REGLAS.forEach((r, i) => expect(consultas[i]!.sql).toContain(`'${r}'`));
  });

  it("cada sentencia llena case_desvios y no repite lo que ya está: la idempotencia es la clave primaria", async () => {
    await revisarDesvios();

    for (const c of consultas) {
      expect(c.sql).toMatch(/^insert into "case_desvios" \(case_id, tenant_id, regla, ancla, dato\) select /);
      expect(c.sql).toMatch(/on conflict \(case_id, regla, ancla\) do nothing$/);
    }
  });

  it("cuenta los desvíos nuevos por regla y en total", async () => {
    insertadas(2, 0, 3, 1, 4);

    const r = await revisarDesvios();

    expect(r.porRegla).toEqual({
      doc_sin_recibir: 2,
      cierre_sin_listo: 0,
      derivacion_sin_respuesta: 3,
      plazo_vencido: 1,
      plan_sin_terminar: 4,
    });
    expect(r.nuevos).toBe(10);
  });

  it("si una regla falla se registra con su nombre y las demás corren igual", async () => {
    insertadas(1, new Error("boom"), 2, 0, 3);

    const r = await revisarDesvios();

    expect(consultas).toHaveLength(5);
    expect(r.porRegla.cierre_sin_listo).toBe(0);
    expect(r.nuevos).toBe(6);
    expect(m.logError).toHaveBeenCalledTimes(1);
    const [datos, mensaje] = m.logError.mock.calls[0]!;
    expect(datos).toMatchObject({ regla: "cierre_sin_listo" });
    expect(mensaje).toBe("desvios.regla_fallo");
    // Sólo un código: nunca el mensaje del error, que puede traer datos.
    expect(JSON.stringify(datos)).not.toContain("boom");
  });

  it("sin rowCount cuenta cero en vez de romper", async () => {
    m.execute.mockResolvedValue({});
    expect((await revisarDesvios()).nuevos).toBe(0);
  });

  it("las cinco fallando no tira: devuelve cero", async () => {
    m.execute.mockRejectedValue(new Error("caída"));
    expect((await revisarDesvios()).nuevos).toBe(0);
    expect(m.logError).toHaveBeenCalledTimes(5);
  });
});

describe("lo que comparten las reglas", () => {
  it("dejan afuera los casos de ensayo", async () => {
    await revisarDesvios();
    for (const c of consultas) expect(c.sql).toContain(`not in ('email_sim', 'whatsapp_sim')`);
  });

  it("cada desvío lleva el inquilino de su caso, no uno de afuera", async () => {
    await revisarDesvios();
    for (const c of consultas) {
      expect(c.sql).toMatch(/select (d|"cases")\.("?)(case_id|id)\2?, (d|"cases")\.("?)tenant_id/);
      expect(c.params).not.toContain("tenant");
    }
  });

  it("los nombres de regla y de evento van como literales, no como parámetros: el índice parcial los necesita así", async () => {
    await revisarDesvios();
    for (const c of consultas) {
      // Sólo los plazos entran por parámetro, y son números.
      for (const p of c.params) expect(typeof p).toBe("number");
    }
  });
});

describe("doc_sin_recibir", () => {
  it("cuenta desde el primer pedido que salió (outbound_messages.asked_keys), no desde requested_at, que nadie escribe", async () => {
    await revisarDesvios();
    const { sql } = de("doc_sin_recibir");

    expect(sql).toContain(`from "outbound_messages" o`);
    expect(sql).toContain("min(o.created_at)");
    expect(sql).toContain("m.doc_key = any(o.asked_keys)");
    expect(sql).toContain("o.status in ('sent', 'skipped_simulated')");
    expect(sql).not.toContain("requested_at");
  });

  it("sólo documentos que siguen pendientes, en un caso que espera al denunciante", async () => {
    await revisarDesvios();
    const { sql } = de("doc_sin_recibir");

    expect(sql).toContain("m.satisfied_at is null and m.declined_at is null");
    expect(sql).toContain(`"cases"."status" in ('esperando', 'info_faltante')`);
  });

  it("a las 72 h del pedido, con el primer pedido como ancla y una fila por caso y pedido", async () => {
    await revisarDesvios();
    const { sql, params } = de("doc_sin_recibir");

    expect(sql).toContain("where d.pedido <= now() - $1::int * interval '1 hour'");
    expect(params).toEqual([72]);
    expect(sql).toContain("group by d.case_id, d.tenant_id, d.pedido");
    expect(sql).toContain(`'doc_sin_recibir', d.pedido, left(string_agg(distinct d.doc_key, ','), 200)`);
  });
});

describe("cierre_sin_listo", () => {
  it("un caso cerrado en los últimos 30 días", async () => {
    await revisarDesvios();
    const { sql, params } = de("cierre_sin_listo");

    expect(sql).toContain(`"cases"."status" in ('cerrado', 'pagado', 'rechazado')`);
    expect(sql).toContain(`"cases"."closed_at" >= now() - $1::int * interval '1 day'`);
    expect(params).toEqual([30]);
  });

  it("sin ningún paso a un estado de completado que efectivamente se haya aplicado", async () => {
    await revisarDesvios();
    const { sql } = de("cierre_sin_listo");

    expect(sql).toMatch(/not exists \( select 1 from "audit_log" a where a\.target_type = 'case'/);
    expect(sql).toContain("(a.payload->>'status_not_applied') is distinct from 'true'");
    expect(sql).toContain(`coalesce(a.payload->>'new_status', a.payload->>'to') in ('listo', 'listo_para_core', 'enviado_a_core', 'en_liquidacion')`);
  });

  it("el listo intermedio de la extracción no cuenta como haber pasado por listo", async () => {
    await revisarDesvios();
    const { sql } = de("cierre_sin_listo");

    expect(sql).toContain(
      `and not (a.event_type = 'ai.extraction_complete' and a.payload->>'new_status' = 'listo') and coalesce(a.payload->>'new_status', a.payload->>'to') in`
    );
  });

  it("sólo casos abiertos después del primer cambio de estado del agente que quedó auditado", async () => {
    await revisarDesvios();
    const { sql, params } = de("cierre_sin_listo");

    expect(sql).toContain(
      `"cases"."created_at" >= ( select min(g.created_at) from "audit_log" g where g.target_type = 'case' and g.event_type in ('case.status_changed') and g.payload->>'trigger' = 'agent')`
    );
    // Sin fecha a mano: el cálculo no agrega parámetros a los del plazo.
    expect(params).toEqual([30]);
  });

  it("el cierre por abandono es un camino previsto, no un desvío", async () => {
    await revisarDesvios();
    expect(de("cierre_sin_listo").sql).toContain("a.event_type in ('claim.closed_abandoned')");
  });

  it("el ancla es cuándo cerró y el dato es el estado en que cerró", async () => {
    await revisarDesvios();
    expect(de("cierre_sin_listo").sql).toContain(
      `'cierre_sin_listo', "cases"."closed_at", "cases"."status"`
    );
  });
});

describe("derivacion_sin_respuesta", () => {
  it("un caso derivado al equipo cuya primera marca de derivación tiene más de 24 h", async () => {
    await revisarDesvios();
    const { sql, params } = de("derivacion_sin_respuesta");

    expect(sql).toContain(`"cases"."status" in ('escalado', 'requiere_especialista')`);
    expect(sql).toContain("a.event_type in ('claim.specialist_required', 'claim.specialist_alerted')");
    expect(sql).toContain("r.t <= now() - $1::int * interval '1 hour'");
    expect(params).toEqual([24]);
  });

  it("sólo cuenta desde la última vez que una persona intervino: el evento sin actor lo escribió el agente", async () => {
    await revisarDesvios();
    const { sql } = de("derivacion_sin_respuesta");

    expect(sql).toContain("i.actor_id is not null");
    expect(sql).toContain("coalesce(( select max(i.created_at)");
    expect(sql).toContain("'-infinity'::timestamptz");
  });

  it("el ancla es esa marca y no lleva dato", async () => {
    await revisarDesvios();
    expect(de("derivacion_sin_respuesta").sql).toContain(`'derivacion_sin_respuesta', r.t, null::text`);
  });
});

describe("plazo_vencido", () => {
  it("el vencimiento de B10 ya pasó y el caso no está cerrado", async () => {
    await revisarDesvios();
    const { sql, params } = de("plazo_vencido");

    expect(sql).toContain(`"cases"."vence_en" is not null and "cases"."vence_en" < now()`);
    expect(sql).toContain(`"cases"."status" not in ('cerrado', 'pagado', 'rechazado')`);
    expect(params).toEqual([]);
  });

  it("el ancla es el vencimiento (si se recalcula es otro desvío) y el dato, el plazo", async () => {
    await revisarDesvios();
    expect(de("plazo_vencido").sql).toContain(
      `'plazo_vencido', "cases"."vence_en", left("cases"."vence_plazo", 40)`
    );
  });
});

describe("plan_sin_terminar", () => {
  it("un caso cerrado en los últimos 30 días con pasos del plan sin hacer", async () => {
    await revisarDesvios();
    const { sql, params } = de("plan_sin_terminar");

    expect(sql).toContain(`join "case_plan_pasos" p on p.case_id = "cases"."id"`);
    expect(sql).toContain(`"cases"."status" in ('cerrado', 'pagado', 'rechazado')`);
    expect(sql).toContain("interval '1 day'");
    expect(params).toEqual([30]);
  });

  it("los pasos que se tildan solos no cuentan, y se agrupa por caso", async () => {
    await revisarDesvios();
    const { sql } = de("plan_sin_terminar");

    expect(sql).toContain("p.auto is null and p.hecho_en is null");
    expect(sql).toContain(`group by "cases"."id", "cases"."tenant_id", "cases"."closed_at"`);
    expect(sql).toContain("left(string_agg(p.clave, ',' order by p.orden), 200)");
  });
});
