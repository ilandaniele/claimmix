/**
 * El presupuesto de IA de un espacio de prueba.
 *
 * Un espacio que se dio de alta solo gasta modelo sin que nadie lo haya
 * contratado, así que `checkBudget` le pone tres límites que los inquilinos de
 * siempre no tienen: un cupo diario de llamadas que se RESERVA antes de llamar
 * (si no, 50 mensajes a la vez pasan todos), un techo mensual por prueba y un
 * pozo compartido por todas. Cada uno corta con su propio motivo.
 *
 * Los inquilinos que no son de alta automática, y la plataforma, siguen igual.
 * Lo que sí cambia para cualquiera: si el contador no contesta, la plataforma
 * deja pasar y el resto se frena.
 *
 * La base es de mentira y el limitador es el de memoria (el de los tests), así
 * que lo que se prueba es la decisión y que el cupo no se pase ni se queme de
 * más, no el SQL; del SQL se comprueba lo que puede romper en producción.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

interface Fila {
  plan: string;
  billing_status: string;
  trial_ends_at: string | null;
  autoalta: boolean | null;
}

const { estado, pedido, borrados } = vi.hoisted(() => ({
  /** Lo que el lote y la suma del proyecto devuelven en cada test. */
  estado: {
    fila: null as Fila | null,
    tokensDelInquilino: 0,
    tokensDeLaOtra: 0,
    usdDelMes: 0,
    proyecto: { total: 0, pruebas: 0 },
    loteFalla: false,
    proyectoFalla: false,
  },
  /** Lo que las consultas del lote pidieron, para mirar su forma. */
  pedido: {
    lotes: [] as number[],
    campos: [] as Array<Record<string, unknown>>,
    filtros: [] as unknown[],
    camposDelProyecto: [] as Array<Record<string, unknown>>,
  },
  borrados: { delete: vi.fn(), update: vi.fn(), insert: vi.fn() },
}));

vi.mock("@/data/scope", () => ({
  enTenantVarias: async (_ctx: unknown, armar: (db: unknown) => unknown[]) => {
    if (estado.loteFalla) throw Object.assign(new Error("connection reset"), { code: "57P01" });
    const inerte = {
      select: (campos: Record<string, unknown>) => {
        pedido.campos.push(campos);
        return {
          from: () => ({
            where: (filtro: unknown) => {
              pedido.filtros.push(filtro);
              return {};
            },
          }),
        };
      },
    };
    pedido.lotes.push(armar(inerte).length);
    return [
      [{ total: estado.tokensDelInquilino }],
      [{ total: estado.tokensDeLaOtra }],
      estado.fila ? [estado.fila] : [],
      [{ usd: estado.usdDelMes }],
    ];
  },
  /** La fila sola, la que lee `reservarSiEsPrueba`. */
  enTenant: async () => {
    if (estado.loteFalla) throw Object.assign(new Error("connection reset"), { code: "57P01" });
    return estado.fila ? [estado.fila] : [];
  },
}));

vi.mock("@/lib/db", async () => {
  const esquema = await vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
  return {
    db: {
      ...borrados,
      select: (campos: Record<string, unknown>) => {
        pedido.camposDelProyecto.push(campos);
        return {
          from: () => ({
            leftJoin: () => ({
              where: async () => {
                if (estado.proyectoFalla) throw new Error("connection reset");
                return [estado.proyecto];
              },
            }),
          }),
        };
      },
    },
    tables: esquema,
  };
});

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...real, rateLimit: vi.fn(real.rateLimit), liberarCupo: vi.fn(real.liberarCupo) };
});

import { checkBudget, reservarSiEsPrueba, soltarReserva } from "@/server/ai/budget";
import { clearAllRateLimits, liberarCupo, rateLimit } from "@/lib/rate-limit";

const PRUEBA = "30000000-0000-0000-0000-000000000003";
const OTRA_PRUEBA = "30000000-0000-0000-0000-000000000004";
const PLATAFORMA = "10000000-0000-0000-0000-000000000001";
const DEMO = "20000000-0000-0000-0000-000000000002";
const DIA_MS = 24 * 60 * 60_000;
const dialecto = new PgDialect();

const ENV = [
  "AI_PILOTO_DAILY_TOKEN_CAP",
  "AI_PRUEBA_MONTHLY_USD_POR_INQUILINO",
  "AI_PRUEBAS_MONTHLY_BUDGET_USD",
  "AI_TENANT_DAILY_TOKEN_CAP",
  "MONTHLY_BUDGET_USD",
  "DEMO_TENANT_ID",
  "GMAIL_TENANT_ID",
  "WHATSAPP_TENANT_ID",
  "DEFAULT_TENANT_ID",
  "GOOGLE_DEFAULT_TENANT_ID",
  "RATE_LIMIT_PROVIDER",
] as const;
const guardadas: Record<string, string | undefined> = {};

function fila(cambios: Partial<Fila> = {}): Fila {
  return {
    plan: "piloto",
    billing_status: "trial",
    trial_ends_at: new Date(Date.now() + 10 * DIA_MS).toISOString(),
    autoalta: true,
    ...cambios,
  };
}

function render(consulta: unknown) {
  return dialecto.sqlToQuery(consulta as SQL);
}

beforeEach(() => {
  for (const k of ENV) {
    guardadas[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GMAIL_TENANT_ID = PLATAFORMA;
  process.env.DEMO_TENANT_ID = DEMO;

  Object.assign(estado, {
    fila: fila(),
    tokensDelInquilino: 0,
    tokensDeLaOtra: 0,
    usdDelMes: 0,
    proyecto: { total: 0, pruebas: 0 },
    loteFalla: false,
    proyectoFalla: false,
  });
  pedido.lotes.length = 0;
  pedido.campos.length = 0;
  pedido.filtros.length = 0;
  pedido.camposDelProyecto.length = 0;
  borrados.delete.mockClear();
  borrados.update.mockClear();
  borrados.insert.mockClear();
  clearAllRateLimits();
});

afterEach(() => {
  for (const k of ENV) {
    if (guardadas[k] === undefined) delete process.env[k];
    else process.env[k] = guardadas[k];
  }
  vi.useRealTimers();
  vi.mocked(rateLimit).mockClear();
  vi.mocked(liberarCupo).mockClear();
});

/** Cuántas de `n` consultas simultáneas pasan. */
async function pasan(n: number, tenantId = PRUEBA, llamadas?: number) {
  const r = await Promise.all(
    Array.from({ length: n }, () => checkBudget(tenantId, null, { llamadas }))
  );
  return r.filter((x) => !x.exceeded).length;
}

describe("el cupo diario de llamadas de una prueba", () => {
  it("50 mensajes a la vez no pasan de 39: se reserva antes de llamar", async () => {
    // 500.000 tokens entre los 12.730 del p95 por llamada.
    const r = await Promise.all(Array.from({ length: 50 }, () => checkBudget(PRUEBA)));

    expect(r.filter((x) => !x.exceeded)).toHaveLength(39);
    const cortadas = r.filter((x) => x.exceeded);
    expect(cortadas).toHaveLength(11);
    expect(new Set(cortadas.map((x) => x.motivo))).toEqual(new Set(["prueba_diaria"]));
  });

  it("AI_PILOTO_DAILY_TOKEN_CAP mueve el cupo", async () => {
    process.env.AI_PILOTO_DAILY_TOKEN_CAP = "127300"; // 10 llamadas

    expect(await pasan(25)).toBe(10);
  });

  it("una variable rota vuelve al valor por omisión, no a 'sin límite'", async () => {
    process.env.AI_PILOTO_DAILY_TOKEN_CAP = "mucho";

    expect(await pasan(50)).toBe(39);
  });

  it("cada prueba tiene su propio cupo", async () => {
    expect(await pasan(39, PRUEBA)).toBe(39);

    expect((await checkBudget(PRUEBA)).motivo).toBe("prueba_diaria");
    expect((await checkBudget(OTRA_PRUEBA)).exceeded).toBe(false);
  });

  it("`llamadas` reserva de a varias, todas o ninguna", async () => {
    // Nueve reservas de cuatro son 36 de 39.
    expect(await pasan(9, PRUEBA, 4)).toBe(9);

    const sinLugar = await checkBudget(PRUEBA, null, { llamadas: 4 });
    expect(sinLugar).toMatchObject({ exceeded: true, motivo: "prueba_diaria" });

    // La reserva que no entró no se llevó las 3 que sí cabían.
    expect(await pasan(5)).toBe(3);
  });

  it("una reserva que no entró devuelve lo que contó", async () => {
    await pasan(9, PRUEBA, 4);
    await checkBudget(PRUEBA, null, { llamadas: 4 });

    // Las 3 que tomó, más la que el limitador rechazó.
    expect(vi.mocked(liberarCupo)).toHaveBeenCalledTimes(4);
  });

  it("sin `llamadas` reserva una", async () => {
    await checkBudget(PRUEBA);

    expect(vi.mocked(rateLimit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rateLimit).mock.calls[0][1]).toMatchObject({
      limit: 39,
      windowMs: DIA_MS,
      fallaCerrada: true,
    });
  });

  it("la clave del cupo es del inquilino", async () => {
    await checkBudget(PRUEBA);

    expect(vi.mocked(rateLimit).mock.calls[0][0]).toBe(`ia:prueba:${PRUEBA}`);
  });

  it("si el limitador no contesta, es 'sin_dato' y no 'prueba_diaria'", async () => {
    process.env.RATE_LIMIT_PROVIDER = "postgres";
    vi.mocked(rateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
      ventana: 0,
    });
    vi.mocked(liberarCupo).mockResolvedValueOnce(undefined);

    expect(await checkBudget(PRUEBA)).toMatchObject({ exceeded: true, motivo: "sin_dato" });
  });
});

describe("mirar el cupo sin gastarlo (`llamadas: 0`)", () => {
  it("no reserva nada, por muchas veces que se mire", async () => {
    for (let i = 0; i < 100; i++) {
      expect((await checkBudget(PRUEBA, null, { llamadas: 0 })).exceeded).toBe(false);
    }

    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
    expect(await pasan(50)).toBe(39);
  });

  it("no devuelve reserva, porque no hay nada que devolver", async () => {
    expect(await checkBudget(PRUEBA, null, { llamadas: 0 })).toEqual({ exceeded: false });
  });

  it("los demás topes de la prueba la frenan igual", async () => {
    estado.usdDelMes = 1;
    expect(await checkBudget(PRUEBA, null, { llamadas: 0 })).toMatchObject({ motivo: "prueba_mensual" });

    estado.usdDelMes = 0;
    estado.proyecto = { total: 40, pruebas: 30 };
    expect(await checkBudget(PRUEBA, null, { llamadas: 0 })).toMatchObject({ motivo: "pozo_de_pruebas" });

    estado.proyecto = { total: 0, pruebas: 0 };
    estado.fila = fila({ trial_ends_at: new Date(Date.now() - 1000).toISOString() });
    expect(await checkBudget(PRUEBA, null, { llamadas: 0 })).toMatchObject({ motivo: "prueba_vencida" });
  });

  it("una cantidad negativa tampoco reserva", async () => {
    await checkBudget(PRUEBA, null, { llamadas: -3 });

    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
  });
});

describe("devolver la reserva", () => {
  it("`checkBudget` devuelve lo que reservó: la clave y la ventana de cada llamada", async () => {
    const cuenta = {
      allowed: true,
      remaining: 10,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 0,
      ventana: 777,
    };
    vi.mocked(rateLimit).mockResolvedValueOnce(cuenta).mockResolvedValueOnce(cuenta);

    const r = await checkBudget(PRUEBA, null, { llamadas: 2 });

    expect(r).toEqual({ exceeded: false, reserva: { clave: `ia:prueba:${PRUEBA}`, ventanas: [777, 777] } });
  });

  it("`soltarReserva` resta cada una en la ventana donde se contó", async () => {
    await soltarReserva({ clave: `ia:prueba:${PRUEBA}`, ventanas: [777, 778] });

    expect(vi.mocked(liberarCupo)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(liberarCupo)).toHaveBeenCalledWith(`ia:prueba:${PRUEBA}`, DIA_MS, 777);
    expect(vi.mocked(liberarCupo)).toHaveBeenCalledWith(`ia:prueba:${PRUEBA}`, DIA_MS, 778);
  });

  it("sin reserva no hace nada", async () => {
    await soltarReserva(undefined);

    expect(vi.mocked(liberarCupo)).not.toHaveBeenCalled();
  });

  it("nunca tira: se llama en caminos que ya están rechazando", async () => {
    vi.mocked(liberarCupo).mockRejectedValueOnce(new Error("connection reset"));

    await expect(soltarReserva({ clave: `ia:prueba:${PRUEBA}`, ventanas: [777] })).resolves.toBeUndefined();
  });

  it("un inquilino de siempre no tiene reserva que devolver", async () => {
    estado.fila = fila({ autoalta: false, billing_status: "active", trial_ends_at: null });

    expect((await checkBudget(OTRA_PRUEBA)).reserva).toBeUndefined();
  });
});

describe("reservar sin releer los topes (`reservarSiEsPrueba`)", () => {
  it("una prueba reserva las llamadas, y devuelve cuáles", async () => {
    const r = await reservarSiEsPrueba(PRUEBA, 4);

    expect(r.exceeded).toBe(false);
    expect(r.reserva?.ventanas).toHaveLength(4);
    expect(vi.mocked(rateLimit)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(rateLimit).mock.calls[0][0]).toBe(`ia:prueba:${PRUEBA}`);
  });

  it("comparte el cupo diario con `checkBudget`: nueve de cuatro son 36 de 39", async () => {
    for (let i = 0; i < 9; i++) await reservarSiEsPrueba(PRUEBA, 4);

    expect(await reservarSiEsPrueba(PRUEBA, 4)).toMatchObject({ exceeded: true, motivo: "prueba_diaria" });
    expect(await pasan(5)).toBe(3);
  });

  it("lee sólo la fila del inquilino: ni los tokens del día ni la suma del proyecto", async () => {
    await reservarSiEsPrueba(PRUEBA, 4);

    expect(pedido.lotes).toEqual([]);
    expect(pedido.camposDelProyecto).toEqual([]);
  });

  it.each([
    ["un inquilino de siempre", () => fila({ autoalta: false, billing_status: "active", trial_ends_at: null })],
    ["un 'trial' que no es de alta automática", () => fila({ autoalta: false })],
    ["un espacio que ya paga", () => fila({ billing_status: "active" })],
    ["un espacio suspendido", () => fila({ billing_status: "suspended" })],
  ])("%s no reserva nada", async (_cual, armar) => {
    estado.fila = armar();

    expect(await reservarSiEsPrueba(OTRA_PRUEBA, 4)).toEqual({ exceeded: false });
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
  });

  it("sin fila no hay reglas de prueba", async () => {
    estado.fila = null;

    expect(await reservarSiEsPrueba(OTRA_PRUEBA, 4)).toEqual({ exceeded: false });
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
  });

  it("si la fila no se puede leer deja pasar y no gasta cupo: el modelo depende de la misma base", async () => {
    estado.loteFalla = true;

    expect(await reservarSiEsPrueba(PRUEBA, 4)).toEqual({ exceeded: false });
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
  });

  it("si el contador del cupo no contesta, se frena", async () => {
    process.env.RATE_LIMIT_PROVIDER = "postgres";
    const sinRespuesta = {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
      ventana: 0,
    };
    vi.mocked(rateLimit).mockResolvedValueOnce(sinRespuesta).mockResolvedValueOnce(sinRespuesta);

    expect(await reservarSiEsPrueba(PRUEBA, 2)).toMatchObject({ exceeded: true, motivo: "sin_dato" });
  });
});

describe("la prueba vencida o el espacio suspendido", () => {
  it("una prueba vencida frena, y no borra nada", async () => {
    estado.fila = fila({ trial_ends_at: new Date(Date.now() - 1000).toISOString() });

    const r = await checkBudget(PRUEBA);

    expect(r).toMatchObject({ exceeded: true, motivo: "prueba_vencida" });
    expect(borrados.delete).not.toHaveBeenCalled();
    expect(borrados.update).not.toHaveBeenCalled();
    expect(borrados.insert).not.toHaveBeenCalled();
  });

  it("no gasta cupo: al renovarse la prueba quedan las 39", async () => {
    estado.fila = fila({ trial_ends_at: new Date(Date.now() - 1000).toISOString() });
    await pasan(10);

    estado.fila = fila();
    expect(await pasan(50)).toBe(39);
  });

  it("una fecha ilegible cuenta como vencida", async () => {
    estado.fila = fila({ trial_ends_at: "no es una fecha" });

    expect((await checkBudget(PRUEBA)).motivo).toBe("prueba_vencida");
  });

  it.each(["suspended", "churned"])("un espacio %s frena con su motivo", async (billing_status) => {
    estado.fila = fila({ billing_status });

    expect(await checkBudget(PRUEBA)).toMatchObject({ exceeded: true, motivo: "suspendido" });
  });

  it("un espacio que ya paga (active) no tiene reglas de prueba", async () => {
    estado.fila = fila({ billing_status: "active", trial_ends_at: null });
    estado.usdDelMes = 500;
    estado.proyecto = { total: 10, pruebas: 10 };

    expect(await pasan(60)).toBe(60);
  });
});

describe("el techo mensual de cada prueba", () => {
  it("corta al llegar a 1 USD, con su motivo", async () => {
    estado.usdDelMes = 1;

    expect(await checkBudget(PRUEBA)).toMatchObject({ exceeded: true, motivo: "prueba_mensual" });
  });

  it("deja pasar por debajo", async () => {
    estado.usdDelMes = 0.99;

    expect((await checkBudget(PRUEBA)).exceeded).toBe(false);
  });

  it("AI_PRUEBA_MONTHLY_USD_POR_INQUILINO lo mueve", async () => {
    process.env.AI_PRUEBA_MONTHLY_USD_POR_INQUILINO = "2";
    estado.usdDelMes = 1.5;
    expect((await checkBudget(PRUEBA)).exceeded).toBe(false);

    estado.usdDelMes = 2;
    expect((await checkBudget(PRUEBA)).motivo).toBe("prueba_mensual");
  });

  it("una variable rota vuelve a 1, no a 'sin techo'", async () => {
    process.env.AI_PRUEBA_MONTHLY_USD_POR_INQUILINO = "un dólar";
    estado.usdDelMes = 1;

    expect((await checkBudget(PRUEBA)).motivo).toBe("prueba_mensual");
  });

  it("una prueba que llegó al techo no deja sin IA a la otra", async () => {
    estado.usdDelMes = 1;
    expect((await checkBudget(PRUEBA)).motivo).toBe("prueba_mensual");

    estado.usdDelMes = 0.1;
    expect((await checkBudget(OTRA_PRUEBA)).exceeded).toBe(false);
  });

  it("no gasta cupo diario cuando el techo ya la frena", async () => {
    estado.usdDelMes = 1;
    await pasan(10);

    estado.usdDelMes = 0;
    expect(await pasan(50)).toBe(39);
  });

  it("lee el mes argentino, no el UTC", async () => {
    // 01:00 UTC del 1 de octubre son las 22:00 del 30 de septiembre en Buenos Aires.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T01:00:00Z"));

    await checkBudget(PRUEBA);

    const delMes = pedido.filtros.map((f) => render(f).params).find((p) => p.includes("2026-09-01"));
    expect(delMes).toBeDefined();
  });
});

describe("el pozo de todas las pruebas", () => {
  it("corta a las pruebas cuando suman 30 USD, con su motivo", async () => {
    estado.proyecto = { total: 40, pruebas: 30 };

    expect(await checkBudget(PRUEBA)).toMatchObject({
      exceeded: true,
      motivo: "pozo_de_pruebas",
    });
  });

  it("no corta a un inquilino que no es de alta automática", async () => {
    estado.proyecto = { total: 40, pruebas: 30 };
    estado.fila = fila({ autoalta: false, billing_status: "active" });

    expect((await checkBudget(PLATAFORMA)).exceeded).toBe(false);
    expect((await checkBudget(OTRA_PRUEBA)).exceeded).toBe(false);
  });

  it("lo que gastan los otros inquilinos no lo agota", async () => {
    estado.proyecto = { total: 150, pruebas: 29.99 };

    expect((await checkBudget(PRUEBA)).exceeded).toBe(false);
  });

  it("AI_PRUEBAS_MONTHLY_BUDGET_USD lo mueve", async () => {
    process.env.AI_PRUEBAS_MONTHLY_BUDGET_USD = "50";
    estado.proyecto = { total: 40, pruebas: 40 };
    expect((await checkBudget(PRUEBA)).exceeded).toBe(false);

    estado.proyecto = { total: 60, pruebas: 50 };
    expect((await checkBudget(PRUEBA)).motivo).toBe("pozo_de_pruebas");
  });

  it("MONTHLY_BUDGET_USD sigue siendo el techo del proyecto y gana", async () => {
    estado.proyecto = { total: 200, pruebas: 30 };

    expect((await checkBudget(PRUEBA)).motivo).toBe("mensual");
  });

  it("el motivo no cuenta cuánto gastó el proyecto", async () => {
    estado.proyecto = { total: 40, pruebas: 30 };

    const { reason } = await checkBudget(PRUEBA);

    expect(reason).not.toMatch(/\d/);
  });

  it("la suma separa lo de las pruebas sin nombrar la columna autoalta", () => {
    // Antes de la 0048 la columna no existe; nombrarla tira 42703.
    return checkBudget(PRUEBA).then(() => {
      const [campos] = pedido.camposDelProyecto;
      const pruebas = render(campos.pruebas);
      expect(pruebas.sql).toContain("filter (where");
      expect(render(campos.total).sql).not.toContain("filter");
    });
  });
});

describe("lo que no cambia para los demás", () => {
  it("un inquilino de siempre no reserva nada", async () => {
    estado.fila = fila({ autoalta: false, billing_status: "active", trial_ends_at: null });

    expect(await pasan(100, OTRA_PRUEBA)).toBe(100);
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
  });

  it("un inquilino 'trial' que no es de alta automática tampoco", async () => {
    // 'piloto' y 'trial' son los valores por omisión de `tenants`: no alcanzan.
    estado.fila = fila({ autoalta: false });

    expect(await pasan(100, OTRA_PRUEBA)).toBe(100);
  });

  it("un inquilino sin fila no tiene reglas de prueba", async () => {
    estado.fila = null;

    expect(await pasan(60, OTRA_PRUEBA)).toBe(60);
  });

  it("los topes de siempre mandan sobre la reserva, y no la gastan", async () => {
    process.env.AI_TENANT_DAILY_TOKEN_CAP = "1000";
    estado.tokensDelInquilino = 1000;
    expect((await checkBudget(PRUEBA)).motivo).toBe("inquilino");
    await pasan(10);

    estado.tokensDelInquilino = 0;
    expect(await pasan(50)).toBe(39);
  });

  it("con MONTHLY_BUDGET_USD en 0 el guardia frena aunque no se haya gastado nada", async () => {
    // /configuracion y /api/health lo muestran como «IA frenada»: el guardia tiene que coincidir.
    process.env.MONTHLY_BUDGET_USD = "0";
    estado.fila = fila({ billing_status: "active", trial_ends_at: null });
    estado.proyecto = { total: 0, pruebas: 0 };

    expect(await checkBudget(OTRA_PRUEBA)).toMatchObject({ exceeded: true, motivo: "mensual" });
  });
});

describe("cuando el contador no contesta", () => {
  it("una prueba se frena, con 'sin_dato'", async () => {
    estado.loteFalla = true;

    expect(await checkBudget(PRUEBA)).toMatchObject({ exceeded: true, motivo: "sin_dato" });
  });

  it("la plataforma sigue, como siempre", async () => {
    estado.loteFalla = true;

    expect(await checkBudget(PLATAFORMA)).toEqual({ exceeded: false });
  });

  it("la demo también", async () => {
    estado.loteFalla = true;

    expect(await checkBudget(DEMO)).toEqual({ exceeded: false });
  });

  it("el inquilino que usa el número de WhatsApp de la plataforma también", async () => {
    const delNumero = "10000000-0000-0000-0000-0000000000aa";
    process.env.WHATSAPP_TENANT_ID = delNumero;
    estado.loteFalla = true;

    expect(await checkBudget(delNumero)).toEqual({ exceeded: false });
  });

  it("si falla la suma del proyecto pasa lo mismo", async () => {
    estado.proyectoFalla = true;

    expect(await checkBudget(PRUEBA)).toMatchObject({ exceeded: true, motivo: "sin_dato" });
    expect(await checkBudget(PLATAFORMA)).toEqual({ exceeded: false });
  });

  it("un inquilino que no es la plataforma también se frena", async () => {
    estado.loteFalla = true;

    expect((await checkBudget(OTRA_PRUEBA)).motivo).toBe("sin_dato");
  });

  it("no gasta cupo del día", async () => {
    estado.loteFalla = true;
    await pasan(5);

    estado.loteFalla = false;
    expect(await pasan(50)).toBe(39);
  });
});

describe("las consultas del lote", () => {
  it("son un solo lote de cuatro: tokens del inquilino, de la otra, su fila y el mes", async () => {
    await checkBudget(PRUEBA);

    expect(pedido.lotes).toEqual([4]);
  });

  it("la fila del inquilino se acota por id y lee autoalta sin nombrar la columna", async () => {
    await checkBudget(PRUEBA);

    const campos = pedido.campos.find((c) => "billing_status" in c)!;
    const autoalta = render(campos.autoalta);
    expect(autoalta.sql).toContain(`to_jsonb("tenants".*)`);
    expect(autoalta.sql).toContain(`->> 'autoalta'`);

    // `tenants` no tiene RLS hasta la 0048: sin el id devolvería a todos.
    const filtro = pedido.filtros.map((f) => render(f)).find((q) => q.params.includes(PRUEBA));
    expect(filtro?.sql).toContain(`"tenants"."id"`);
  });

  it("el gasto del mes sale del acumulador mensual", async () => {
    await checkBudget(PRUEBA);

    const campos = pedido.campos.find((c) => "usd" in c)!;
    expect(render(campos.usd).sql).toContain(`"ai_usage_mensual"."cost_usd"`);
  });
});
