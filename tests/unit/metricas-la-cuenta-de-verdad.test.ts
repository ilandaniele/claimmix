/**
 * La pantalla de métricas, ejecutada.
 *
 * `estados-que-cuentan-las-metricas.test.ts` prueba los CONJUNTOS
 * —`ESTADOS_COMPLETADO_SIN_PERSONA`, `ESTADOS_ESCALADO`— y hace bien: ese fue el
 * bug, y contarlos mal mostraba «0 %» y «0 siniestros» con 28 completados y 43
 * escalados en la base.
 *
 * Pero `getTenantKpis`, que es lo que convierte esas filas en los números que
 * mira una persona, tenía 0 % de cobertura. Las divisiones, los redondeos, el
 * `null` que distingue «no hubo cierres» de «cerró en cero minutos» y el relleno
 * de los nueve tipos de siniestro no los tocaba ningún test.
 *
 * Lo que se prueba acá es esa aritmética, sobre filas que la base podría
 * devolver de verdad.
 */

vi.mock("server-only", () => ({}));

const { mockVarias } = vi.hoisted(() => ({ mockVarias: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenantVarias: mockVarias,
  enTenant: vi.fn(),
}));

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { consultaDeActividad, getTenantKpis } from "@/server/metrics/kpis";
import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import type { PuntoSerie } from "@/core/metricas/serie";
import type { FilaDeCiclo, FilaDeCuello } from "@/core/metricas/ciclo";
import { SITUACION_EN_CERO } from "../mocks/metricas-datos";

const CTX = { tenantId: "10000000-0000-0000-0000-000000000001" };

const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };

const SIN_CICLO: FilaDeCiclo = {
  reclamos: 0,
  con_listo: 0,
  mediana_horas_listo: null,
  con_cierre: 0,
  mediana_horas_cierre: null,
  sin_intervencion: 0,
  mensajes_por_caso: null,
};

/**
 * Las once consultas fijas del lote, en el orden en que `getTenantKpis` las arma.
 *
 * Lo que NO se prueba acá es el SQL: el armador no se ejecuta, así que una
 * consulta mal construida no se cae en este archivo. Eso lo cubren los tests
 * de integración, que corren contra una base de verdad. Acá está la aritmética
 * que hay entre las filas y la pantalla, que es lo que no tenía nada.
 */
function baseCon(over: Partial<{
  resumen: { total: number; listo: number; respondidos: number; minutos: number };
  porEstado: Array<{ status: string; n: number }>;
  porTipo: Array<{ claim_type: string | null; n: number }>;
  escalados: number;
  analistas: Array<{ assigned_to: string | null; full_name: string | null; n: number }>;
  usoDelMes: typeof SIN_USO;
  usoHistorico: typeof SIN_USO;
  porPersona: Array<Record<string, unknown>>;
  porModelo: Array<Record<string, unknown>>;
  ciclo: Partial<FilaDeCiclo>;
  cuellos: Array<Omit<FilaDeCuello, "horas_promedio"> & { horas_promedio: number }>;
  serie: PuntoSerie[];
}> = {}) {
  mockVarias.mockImplementation(async () => [
    [over.resumen ?? { total: 0, listo: 0, respondidos: 0, minutos: 0 }],
    over.porEstado ?? [],
    over.porTipo ?? [],
    [{ n: over.escalados ?? 0 }],
    over.analistas ?? [],
    [over.usoDelMes ?? SIN_USO],
    [over.usoHistorico ?? SIN_USO],
    over.porPersona ?? [],
    over.porModelo ?? [],
    // Lo que la base devuelve para una agregación sin filas es UNA fila de nulos.
    [{ ...SIN_CICLO, ...over.ciclo }],
    over.cuellos ?? [],
    // Va después, y sólo cuando se pidió, como en el lote de verdad.
    ...(over.serie ? [over.serie] : []),
  ]);
}

beforeEach(() => mockVarias.mockReset());

describe("getTenantKpis — la tasa de completitud", () => {
  it("es el porcentaje redondeado de los completados del mes", async () => {
    baseCon({ resumen: { total: 455, listo: 28, respondidos: 0, minutos: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.total_cases_month).toBe(455);
    expect(summary.completado_confirmado_rate).toBe(6);
  });

  it("sin casos en el mes es 0 y no NaN", async () => {
    // `0 / 0` es NaN, y un NaN en esta pantalla se renderiza como «NaN%».
    baseCon({ resumen: { total: 0, listo: 0, respondidos: 0, minutos: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.completado_confirmado_rate).toBe(0);
  });

  it("ya no se publica con el nombre viejo, que prometía lo que no medía", async () => {
    baseCon({ resumen: { total: 10, listo: 5, respondidos: 0, minutos: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary).not.toHaveProperty("auto_completion_rate");
  });
});

describe("getTenantKpis — el ciclo y lo que se resuelve sin personas", () => {
  it("sin_intervencion_rate es el porcentaje de los reclamos del período", async () => {
    baseCon({ ciclo: { reclamos: 8, sin_intervencion: 3 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.sin_intervencion_rate).toBe(38);
  });

  it("sin reclamos es null y no 0 %: no hubo sobre qué medir", async () => {
    baseCon({ ciclo: { reclamos: 0, sin_intervencion: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.sin_intervencion_rate).toBeNull();
  });

  it("las medianas y los mensajes llevan un decimal, y null se queda null", async () => {
    baseCon({
      ciclo: {
        mediana_horas_listo: 3.4567,
        con_listo: 5,
        mediana_horas_cierre: null,
        con_cierre: 0,
        mensajes_por_caso: 7.25,
      },
    });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.ciclo).toEqual({
      mediana_horas_listo: 3.5,
      casos_listo: 5,
      mediana_horas_cierre: null,
      casos_cierre: 0,
    });
    expect(summary.mensajes_por_caso).toBe(7.3);
  });

  it("una mediana de cero horas se conserva: es distinta de no tener dato", async () => {
    baseCon({ ciclo: { mediana_horas_listo: 0, con_listo: 2 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.ciclo.mediana_horas_listo).toBe(0);
  });

  it("los cuellos salen redondeados y sólo con estados que el esquema conoce", async () => {
    // El nombre del estado sale de un payload de auditoría: un valor viejo o
    // ajeno no tiene que llegar a la pantalla.
    baseCon({
      cuellos: [
        { estado: "requiere_especialista", horas_promedio: 30.04, estancias: 4 },
        { estado: "inventado", horas_promedio: 99, estancias: 1 },
        { estado: "__proto__", horas_promedio: 99, estancias: 1 },
      ],
    });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.cuellos).toEqual([
      { estado: "requiere_especialista", horas_promedio: 30, estancias: 4 },
    ]);
  });
});

describe("getTenantKpis — el período elegido", () => {
  afterEach(() => vi.useRealTimers());

  it("por omisión es el mes en curso, y el rango devuelto es el de ese mes argentino", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    baseCon();

    const { periodo, period } = await getTenantKpis(CTX);

    expect(periodo).toBe("este_mes");
    expect(period).toEqual({ start: "2026-09-01T03:00:00.000Z", end: "2026-10-01T03:00:00.000Z" });
  });

  it("con mes_pasado el rango es el del mes anterior", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    baseCon();

    const { periodo, period } = await getTenantKpis(CTX, { periodo: "mes_pasado" });

    expect(periodo).toBe("mes_pasado");
    expect(period).toEqual({ start: "2026-08-01T03:00:00.000Z", end: "2026-09-01T03:00:00.000Z" });
  });
});

describe("getTenantKpis — el tiempo hasta la primera respuesta", () => {
  it("promedia sólo los casos que de verdad se respondieron", async () => {
    baseCon({ resumen: { total: 10, listo: 2, respondidos: 4, minutos: 1000 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.avg_first_response_minutes).toBe(250);
  });

  it("sin respuestas es null, no cero", async () => {
    // Cero minutos es una afirmación —«se responde al instante»— y no hubo
    // ninguna respuesta que la respalde. La pantalla muestra un guión con null.
    baseCon({ resumen: { total: 10, listo: 2, respondidos: 0, minutos: 0 } });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.avg_first_response_minutes).toBeNull();
  });
});

describe("getTenantKpis — la distribución por tipo", () => {
  it("muestra los nueve tipos del esquema, incluso los que no tuvieron casos", async () => {
    // Sembrar sólo los que aparecen deja el gráfico leyéndose como si esos
    // tipos no existieran.
    baseCon({ porTipo: [{ claim_type: "choque", n: 12 }] });

    const { by_type } = await getTenantKpis(CTX);

    expect(by_type.choque).toBe(12);
    for (const t of ClaimTypeSchema.options) {
      expect(by_type).toHaveProperty(t);
    }
  });

  it("una fila sin tipo no inventa una categoría", async () => {
    baseCon({ porTipo: [{ claim_type: null, n: 7 }, { claim_type: "robo", n: 3 }] });

    const { by_type } = await getTenantKpis(CTX);

    expect(by_type.robo).toBe(3);
    expect(Object.values(by_type)).not.toContain(7);
  });

  it("cuenta sólo reclamos: el where trae is_claim is true", async () => {
    // Un `no_relevante` puede arrastrar un `claim_type` del intento previo, y
    // sin este filtro sumaba como si fuera un reclamo de verdad.
    baseCon();
    await getTenantKpis(CTX);

    const armador = mockVarias.mock.calls[0]![1] as (db: unknown) => { toSQL(): { sql: string } }[];
    const { sql } = armador(new QueryBuilder() as never)[2]!.toSQL();

    expect(sql).toMatch(/"cases"\."is_claim" is true/);
  });
});

describe("getTenantKpis — el consumo de IA", () => {
  it("suma los tokens de las dos puntas y ordena por consumo", async () => {
    baseCon({
      porPersona: [
        { user_id: "u-1", full_name: "Ana", email: "ana@x.com", calls: 2, prompt_tokens: 100, completion_tokens: 50, cost_usd: 1 },
        { user_id: "u-2", full_name: "Beto", email: "beto@x.com", calls: 9, prompt_tokens: 900, completion_tokens: 100, cost_usd: 5 },
      ],
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.by_user[0]!.full_name).toBe("Beto");
    expect(ai_usage.by_user[0]!.total_tokens).toBe(1000);
    expect(ai_usage.by_user[1]!.total_tokens).toBe(150);
  });

  it("lo que gastó el sistema tiene nombre, no una fila en blanco", async () => {
    // `user_id: null` es el worker: el gasto existe y alguien lo paga.
    baseCon({
      porPersona: [
        { user_id: null, full_name: null, email: null, calls: 3, prompt_tokens: 30, completion_tokens: 3, cost_usd: 0.1 },
      ],
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.by_user[0]!.full_name).toBe("Sistema");
    expect(ai_usage.by_user[0]!.email).toBe("Procesos automáticos");
  });

  it("no muestra más de ocho personas", async () => {
    baseCon({
      porPersona: Array.from({ length: 12 }, (_, i) => ({
        user_id: `u-${i}`,
        full_name: `Persona ${i}`,
        email: `p${i}@x.com`,
        calls: 1,
        prompt_tokens: i * 10,
        completion_tokens: 0,
        cost_usd: 0,
      })),
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.by_user).toHaveLength(8);
    // Las ocho que más gastaron, no las ocho primeras.
    expect(ai_usage.by_user[0]!.total_tokens).toBe(110);
  });

  it("las columnas numéricas vuelven como texto desde Drizzle y se convierten", async () => {
    baseCon({
      usoDelMes: { calls: "4", prompt_tokens: "1200", completion_tokens: "300", cost_usd: "0.0450" } as never,
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.month.total_tokens).toBe(1500);
    expect(ai_usage.month.cost_usd).toBeCloseTo(0.045, 4);
  });
});

describe("getTenantKpis — los escalados", () => {
  it("salen de su propia consulta, no del conteo por estado", async () => {
    // Son dos consultas: si la tarjeta leyera el conteo por estado, dejaría de
    // coincidir con los escalados en cuanto cambie un solo filtro de una de las dos.
    baseCon({
      escalados: 43,
      porEstado: [{ status: "requiere_especialista", n: 260 }],
    });

    const { summary, by_status } = await getTenantKpis(CTX);

    expect(summary.escalated_count).toBe(43);
    expect(by_status.requiere_especialista).toBe(260);
  });
});

describe("getTenantKpis — la serie de actividad", () => {
  afterEach(() => vi.useRealTimers());

  /*
   * Un cliente que acepta cualquier cadena y se devuelve a sí mismo: alcanza
   * para ejecutar el armador y contar cuántas consultas mete en el lote, sin
   * base. Lo que se afirma es que la serie viaja en el MISMO lote y que
   * /api/metricas, que no la pide, sigue en las once fijas.
   */
  const cadena: unknown = new Proxy(() => cadena, {
    get: () => cadena,
    apply: () => cadena,
  });
  const consultasDelLote = () =>
    (mockVarias.mock.calls[0]![1] as (db: unknown) => unknown[])(cadena).length;

  it("sin pedirla vuelve null y el lote sigue en once consultas", async () => {
    baseCon();

    const { serie } = await getTenantKpis(CTX);

    expect(serie).toBeNull();
    expect(mockVarias).toHaveBeenCalledTimes(1);
    expect(consultasDelLote()).toBe(11);
  });

  it("pedida, va como consulta doce del mismo viaje", async () => {
    baseCon({ serie: [] });

    await getTenantKpis(CTX, { serie: "dia" });

    expect(mockVarias).toHaveBeenCalledTimes(1);
    expect(consultasDelLote()).toBe(12);
  });

  it("el resumen de ayer también viaja en el mismo lote", async () => {
    baseCon({ serie: [] });

    await getTenantKpis(CTX, { serie: "dia", ayer: true });
    expect(mockVarias).toHaveBeenCalledTimes(1);
    expect(consultasDelLote()).toBe(13);

    mockVarias.mockClear();
    baseCon();
    await getTenantKpis(CTX, { ayer: true });
    expect(consultasDelLote()).toBe(12);
  });

  it("pone las filas en su mes y rellena los doce con cero", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    const septiembre = {
      clave: "2026-09",
      reclamos: 5,
      whatsapps: 3,
      mails: 2,
      reclamos_whatsapp: 3,
      reclamos_mail: 2,
      ...SITUACION_EN_CERO,
    };
    baseCon({ serie: [septiembre] });

    const { serie } = await getTenantKpis(CTX, { serie: "mes" });

    expect(serie).toHaveLength(12);
    expect(serie!.at(-1)).toEqual(septiembre);
    expect(serie![0]!.clave).toBe("2025-10");
    expect(serie!.slice(0, -1).every((p) => p.reclamos + p.whatsapps + p.mails === 0)).toBe(true);
  });
});

describe("consultaDeActividad — el SQL que arma", () => {
  /*
   * Sin base: `QueryBuilder` arma el mismo SQL que el cliente y no conecta.
   * Ejecutarlo lo hace `pnpm capa-datos`, contra los casos contados en JS.
   */
  const consulta = consultaDeActividad(
    new QueryBuilder() as never,
    "dia",
    "2026-08-02T03:00:00.000Z"
  );
  const { sql, params } = consulta.toSQL();

  it("agrupa por el día argentino, no por el de UTC", () => {
    const zona = params.indexOf(ZONA_ARGENTINA) + 1;

    expect(zona).toBeGreaterThan(0);
    expect(sql).toContain(`"created_at" at time zone $${zona}`);
    expect(params).toEqual(expect.arrayContaining(["day", "YYYY-MM-DD"]));
  });

  it("las seis series cuentan sólo WhatsApp y mail reales, sin simulaciones", () => {
    expect(sql).toMatch(/"cases"\."channel" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["whatsapp", "email"]));
    expect(params.filter((p) => String(p).endsWith("_sim"))).toEqual([]);
  });

  it("cada columna cuenta lo suyo: reclamos los que son, y cada canal el suyo", () => {
    // Estos literales van en el texto y no como parámetros, así que el test de
    // arriba no los ve: invertir los dos canales, o sumar los `null` a los
    // reclamos con un `is not false`, pasaba verde.
    // Drizzle tipa cada campo como «ponele alias»; en ejecución es el SQL tal cual.
    const campos = consulta._.selectedFields as unknown as Record<keyof PuntoSerie, SQL>;
    const dialecto = new PgDialect();
    const columna = (campo: keyof PuntoSerie) => dialecto.sqlToQuery(campos[campo]).sql;

    expect(columna("reclamos")).toMatch(/filter \(where "cases"\."is_claim" is true\)/);
    expect(columna("whatsapps")).toMatch(/filter \(where "cases"\."channel" = 'whatsapp'\)/);
    expect(columna("mails")).toMatch(/filter \(where "cases"\."channel" = 'email'\)/);
    expect(columna("reclamos_whatsapp")).toMatch(
      /filter \(where "cases"\."is_claim" is true and "cases"\."channel" = 'whatsapp'\)/
    );
    expect(columna("reclamos_mail")).toMatch(
      /filter \(where "cases"\."is_claim" is true and "cases"\."channel" = 'email'\)/
    );
  });

  it("las tres de situación cuentan por el estado de hoy del caso, no por la auditoría", () => {
    const campos = consulta._.selectedFields as unknown as Record<keyof PuntoSerie, SQL>;
    const dialecto = new PgDialect();
    const columna = (campo: keyof PuntoSerie) => dialecto.sqlToQuery(campos[campo]);

    for (const campo of ["escalados", "listos", "cerrados"] as const) {
      expect(columna(campo).sql).toMatch(/filter \(where "cases"\."status" in \(/);
    }
    expect(columna("escalados").params).toEqual(
      expect.arrayContaining(["requiere_especialista", "escalado"])
    );
    expect(columna("listos").params).toEqual(expect.arrayContaining(["listo_para_core"]));
    expect(columna("cerrados").params).toEqual(
      expect.arrayContaining(["cerrado", "pagado", "rechazado"])
    );
    expect(sql).not.toContain("audit_log");
  });

  it("devuelve filas con la forma de PuntoSerie", () => {
    // El lote de getTenantKpis y el cruce de `pnpm capa-datos` afirman
    // PuntoSerie en vez de inferirlo del armador: si el SELECT y el tipo se
    // separan, esto deja de compilar.
    expectTypeOf<Awaited<ReturnType<typeof consultaDeActividad>>[number]>().toEqualTypeOf<PuntoSerie>();
  });
});
