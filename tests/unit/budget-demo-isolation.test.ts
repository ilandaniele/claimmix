/**
 * La demo pública no puede apagar el intake de un asegurador.
 *
 * /api/demo/public-analyze corre sin autenticación — así tiene que ser, es la
 * pantalla que ve un prospecto — y descontaba del mismo presupuesto que las
 * denuncias reales. Dos topes lo frenan y los dos eran compartidos: el cupo
 * diario del tenant, que era el de producción, y el tope mensual en dólares,
 * que no filtraba por tenant en absoluto.
 *
 * O sea que un anónimo rotando IPs —que cuesta centavos— agotaba cualquiera de
 * los dos, y a partir de ahí ninguna denuncia real se extraía. Sin ruido: el
 * worker anota un warn y el caso se queda esperando. Un asegurado escribe,
 * nadie contesta, y en los tableros está todo verde.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rows: Record<string, unknown>[] = [];
const captured: { where: unknown }[] = [];

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          captured.push({ where: w });
          return Promise.resolve([rows.shift() ?? {}]);
        },
      }),
    }),
  },
  tables: {
    aiUsage: {
      tenant_id: { name: "tenant_id" },
      user_id: { name: "user_id" },
      created_at: { name: "created_at" },
      cost_usd: { name: "cost_usd" },
      prompt_tokens: { name: "prompt_tokens" },
      completion_tokens: { name: "completion_tokens" },
    },
  },
}));

import { checkBudget, checkDemoBudget, getDemoTenantId } from "@/server/ai/budget";

const DEMO = "20000000-0000-0000-0000-000000000002";
const REAL = "10000000-0000-0000-0000-000000000001";
const SAVED = { ...process.env };

beforeEach(() => {
  rows.length = 0;
  captured.length = 0;
  process.env.DEMO_TENANT_ID = DEMO;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("getDemoTenantId", () => {
  it("no cae al tenant de producción cuando falta la variable", () => {
    // El fallback anterior era literalmente el bug: sin configuración, la demo
    // gastaba del presupuesto del asegurador.
    delete process.env.DEMO_TENANT_ID;
    expect(getDemoTenantId()).toBeNull();
  });
});

describe("checkBudget — el tope mensual de producción", () => {
  it("no cuenta lo que gastó la demo", async () => {
    rows.push({ total: 1 }, { total: 0 }); // mensual, diario del tenant
    await checkBudget(REAL);

    // La condición del mensual tiene que excluir al tenant de la demo. Sin
    // esto el gasto anónimo empuja el tope compartido y frena el intake real.
    const monthly = JSON.stringify(captured[0]?.where ?? {});
    expect(monthly).toContain(DEMO);
  });

  it("sigue frenando cuando el gasto real llega al tope", async () => {
    process.env.MONTHLY_BUDGET_USD = "50";
    rows.push({ total: 50 });
    const r = await checkBudget(REAL);
    expect(r.exceeded).toBe(true);
  });
});

describe("checkDemoBudget", () => {
  it("frena por cupo diario de tokens", async () => {
    process.env.AI_DEMO_DAILY_TOKEN_CAP = "1000";
    rows.push({ tokens: 1000 });
    const r = await checkDemoBudget();
    expect(r.exceeded).toBe(true);
  });

  it("frena por cupo mensual en dólares", async () => {
    process.env.AI_DEMO_DAILY_TOKEN_CAP = "1000000";
    process.env.DEMO_MONTHLY_BUDGET_USD = "10";
    rows.push({ tokens: 5 }, { usd: 10 });
    const r = await checkDemoBudget();
    expect(r.exceeded).toBe(true);
  });

  it("deja pasar dentro del cupo", async () => {
    process.env.AI_DEMO_DAILY_TOKEN_CAP = "1000000";
    process.env.DEMO_MONTHLY_BUDGET_USD = "10";
    rows.push({ tokens: 5 }, { usd: 0.01 });
    expect((await checkDemoBudget()).exceeded).toBe(false);
  });

  it("sin tenant propio no atiende", async () => {
    delete process.env.DEMO_TENANT_ID;
    expect((await checkDemoBudget()).exceeded).toBe(true);
  });

  it("si no puede medir el gasto, se apaga en vez de seguir gastando", async () => {
    // Al revés que checkBudget, y a propósito: acá el peor caso es que la demo
    // no ande un rato. Allá es que un asegurador se quede sin intake.
    process.env.AI_DEMO_DAILY_TOKEN_CAP = "1000000";
    const { db } = await import("@/lib/db");
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("connection reset");
    });
    expect((await checkDemoBudget()).exceeded).toBe(true);
  });
});
