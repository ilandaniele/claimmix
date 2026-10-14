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
 * Las cinco consultas fijas del lote, en el orden en que `getTenantKpis` las arma.
 *
 * La primera trae en una sola pasada las filas por estado (`por_tipo` 0) y por
 * tipo (`por_tipo` 1); la tercera, las del uso de IA según `grupo` (1 por
 * persona, 2 por modelo, 3 los totales). Cada opción arma las filas de lo suyo.
 *
 * Lo que NO se prueba acá es el SQL: el armador no se ejecuta, así que una
 * consulta mal construida no se cae en este archivo. Eso lo cubren los tests
 * de integración, que corren contra una base de verdad. Acá está la aritmética
 * que hay entre las filas y la pantalla, que es lo que no tenía nada.
 */
function baseCon(over: Partial<{
  porEstado: Array<{ status: string; n: number; listo?: number; respondidos?: number; minutos?: number }>;
  porTipo: Array<{ claim_type: string | null; n: number; reclamos?: number }>;
  analistas: Array<{ assigned_to: string | null; full_name: string | null; n: number }>;
  usoDelMes: typeof SIN_USO;
  usoHistorico: typeof SIN_USO;
  porPersona: Array<{ user_id: string | null; full_name: string | null; email: string | null; mes: typeof SIN_USO }>;
  porModelo: Array<{ model: string | null; mes: typeof SIN_USO }>;
  ciclo: Partial<FilaDeCiclo>;
  cuellos: Array<Omit<FilaDeCuello, "horas_promedio"> & { horas_promedio: number }>;
  serie: PuntoSerie[];
}> = {}) {
  const sinAgrupar = { user_id: null, full_name: null, email: null, model: null };
  mockVarias.mockImplementation(async () => [
    [
      ...(over.porEstado ?? []).map((fila) => ({
        por_tipo: 0,
        claim_type: null,
        reclamos: 0,
        listo: 0,
        respondidos: 0,
        minutos: 0,
        ...fila,
      })),
      ...(over.porTipo ?? []).map((fila) => ({
        por_tipo: 1,
        status: null,
        reclamos: fila.n,
        listo: 0,
        respondidos: 0,
        minutos: 0,
        ...fila,
      })),
    ],
    over.analistas ?? [],
    [
      ...(over.porPersona ?? []).map((fila) => ({ ...sinAgrupar, grupo: 1, total: fila.mes, ...fila })),
      ...(over.porModelo ?? []).map((fila) => ({ ...sinAgrupar, grupo: 2, total: fila.mes, ...fila })),
      { ...sinAgrupar, grupo: 3, mes: over.usoDelMes ?? SIN_USO, total: over.usoHistorico ?? SIN_USO },
    ],
    // Lo que la base devuelve para una agregación sin filas es UNA fila de nulos.
    [{ ...SIN_CICLO, ...over.ciclo }],
    over.cuellos ?? [],
    // Va después, y sólo cuando se pidió, como en el lote de verdad.
    ...(over.serie ? [over.serie] : []),
  ]);
}

beforeEach(() => mockVarias.mockReset());

describe("getTenantKpis — la tasa de completitud", () => {
  it("es el porcentaje redondeado de los completados del mes, sumando todos los estados", async () => {
    baseCon({
      porEstado: [
        { status: "procesando", n: 400 },
        { status: "en_liquidacion", n: 55, listo: 28 },
      ],
    });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.total_cases_month).toBe(455);
    expect(summary.completado_confirmado_rate).toBe(6);
  });

  it("sin casos en el mes es 0 y no NaN", async () => {
    // `0 / 0` es NaN, y un NaN en esta pantalla se renderiza como «NaN%».
    baseCon();

    const { summary } = await getTenantKpis(CTX);

    expect(summary.completado_confirmado_rate).toBe(0);
  });

  it("ya no se publica con el nombre viejo, que prometía lo que no medía", async () => {
    baseCon({ porEstado: [{ status: "procesando", n: 10, listo: 5 }] });

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
  it("promedia sólo los casos que de verdad se respondieron, de todos los estados", async () => {
    baseCon({
      porEstado: [
        { status: "procesando", n: 6, respondidos: 1, minutos: 100 },
        { status: "cerrado", n: 4, listo: 2, respondidos: 3, minutos: 900 },
      ],
    });

    const { summary } = await getTenantKpis(CTX);

    expect(summary.avg_first_response_minutes).toBe(250);
  });

  it("sin respuestas es null, no cero", async () => {
    // Cero minutos es una afirmación —«se responde al instante»— y no hubo
    // ninguna respuesta que la respalde. La pantalla muestra un guión con null.
    baseCon({ porEstado: [{ status: "procesando", n: 10, listo: 2 }] });

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

  it("un tipo que sólo trae casos no reclamo se queda en cero", async () => {
    // Un `no_relevante` puede arrastrar un `claim_type` del intento previo:
    // la fila existe pero no tiene reclamos.
    baseCon({ porTipo: [{ claim_type: "robo", n: 4, reclamos: 0 }] });

    const { by_type } = await getTenantKpis(CTX);

    expect(by_type.robo).toBe(0);
  });

  it("las filas por tipo no suman al total del mes ni al conteo por estado", async () => {
    baseCon({
      porEstado: [{ status: "procesando", n: 10 }],
      porTipo: [{ claim_type: "choque", n: 10 }],
    });

    const { summary, by_status } = await getTenantKpis(CTX);

    expect(summary.total_cases_month).toBe(10);
    expect(by_status).toEqual({ procesando: 10 });
  });

  it("cuenta sólo reclamos: el conteo de la consulta lleva is_claim is true", async () => {
    // Un `no_relevante` puede arrastrar un `claim_type` del intento previo, y
    // sin este filtro sumaba como si fuera un reclamo de verdad.
    baseCon();
    await getTenantKpis(CTX);

    const armador = mockVarias.mock.calls[0]![1] as (db: unknown) => { toSQL(): { sql: string } }[];
    const { sql } = armador(new QueryBuilder() as never)[0]!.toSQL();

    expect(sql).toMatch(/count\(\*\) filter \(where "cases"\."is_claim" is true\)/);
    expect(sql).toContain(`group by grouping sets (("cases"."status"), ("cases"."claim_type"))`);
  });
});

describe("getTenantKpis — el consumo de IA", () => {
  it("suma los tokens de las dos puntas y ordena por consumo", async () => {
    baseCon({
      porPersona: [
        { user_id: "u-1", full_name: "Ana", email: "ana@x.com", mes: { calls: 2, prompt_tokens: 100, completion_tokens: 50, cost_usd: 1 } },
        { user_id: "u-2", full_name: "Beto", email: "beto@x.com", mes: { calls: 9, prompt_tokens: 900, completion_tokens: 100, cost_usd: 5 } },
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
        { user_id: null, full_name: null, email: null, mes: { calls: 3, prompt_tokens: 30, completion_tokens: 3, cost_usd: 0.1 } },
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
        mes: { calls: 1, prompt_tokens: i * 10, completion_tokens: 0, cost_usd: 0 },
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

  it("por persona y por modelo salen sólo los que usaron IA este mes; el total histórico, de la fila de totales", async () => {
    // Quien sólo tiene uso de meses anteriores trae `mes.calls` en cero.
    baseCon({
      porPersona: [
        { user_id: "u-1", full_name: "Ana", email: "ana@x.com", mes: { calls: 2, prompt_tokens: 100, completion_tokens: 50, cost_usd: 1 } },
        { user_id: "u-2", full_name: "Beto", email: "beto@x.com", mes: SIN_USO },
      ],
      porModelo: [
        { model: "gemini-2.5-flash", mes: { calls: 2, prompt_tokens: 100, completion_tokens: 50, cost_usd: 1 } },
        { model: "gemini-viejo", mes: SIN_USO },
      ],
      usoHistorico: { calls: 40, prompt_tokens: 4000, completion_tokens: 1000, cost_usd: 9 },
    });

    const { ai_usage } = await getTenantKpis(CTX);

    expect(ai_usage.by_user.map((u) => u.full_name)).toEqual(["Ana"]);
    expect(ai_usage.by_model.map((m) => m.model)).toEqual(["gemini-2.5-flash"]);
    expect(ai_usage.month.calls).toBe(0);
    expect(ai_usage.all_time.total_tokens).toBe(5000);
  });
});

describe("getTenantKpis — los escalados", () => {
  it("suman los dos estados de escalado del mismo conteo por estado", async () => {
    // Una sola consulta para la tarjeta y la distribución: no pueden dejar de
    // coincidir aunque cambie un filtro.
    baseCon({
      porEstado: [
        { status: "requiere_especialista", n: 40 },
        { status: "escalado", n: 3 },
        { status: "procesando", n: 200 },
      ],
    });

    const { summary, by_status } = await getTenantKpis(CTX);

    expect(summary.escalated_count).toBe(43);
    expect(summary.total_cases_month).toBe(243);
    expect(by_status.requiere_especialista).toBe(40);
  });
});

describe("getTenantKpis — la serie de actividad", () => {
  afterEach(() => vi.useRealTimers());

  /*
   * Un cliente que acepta cualquier cadena y se devuelve a sí mismo: alcanza
   * para ejecutar el armador y contar cuántas consultas mete en el lote, sin
   * base. Lo que se afirma es que la serie viaja en el MISMO lote y que
   * /api/metricas, que no la pide, sigue en las cinco fijas.
   */
  const cadena: unknown = new Proxy(() => cadena, {
    get: () => cadena,
    apply: () => cadena,
  });
  const consultasDelLote = () =>
    (mockVarias.mock.calls[0]![1] as (db: unknown) => unknown[])(cadena).length;

  it("sin pedirla vuelve null y el lote sigue en cinco consultas", async () => {
    baseCon();

    const { serie } = await getTenantKpis(CTX);

    expect(serie).toBeNull();
    expect(mockVarias).toHaveBeenCalledTimes(1);
    expect(consultasDelLote()).toBe(5);
  });

  it("pedida, va como consulta seis del mismo viaje", async () => {
    baseCon({ serie: [] });

    await getTenantKpis(CTX, { serie: "dia" });

    expect(mockVarias).toHaveBeenCalledTimes(1);
    expect(consultasDelLote()).toBe(6);
  });

  it("el resumen de ayer también viaja en el mismo lote", async () => {
    baseCon({ serie: [] });

    await getTenantKpis(CTX, { serie: "dia", ayer: true });
    expect(mockVarias).toHaveBeenCalledTimes(1);
    expect(consultasDelLote()).toBe(7);

    mockVarias.mockClear();
    baseCon();
    await getTenantKpis(CTX, { ayer: true });
    expect(consultasDelLote()).toBe(6);
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

  it("las seis series cuentan sólo los canales reales (WhatsApp, mail y web), sin simulaciones", () => {
    expect(sql).toMatch(/"cases"\."channel" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["whatsapp", "email", "web"]));
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
