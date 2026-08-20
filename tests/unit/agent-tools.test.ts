/**
 * What the agent may find out, and what it may not be told.
 *
 * Giving it lookups is what stops it asking for a policy number that is
 * sitting in our own database under the DNI the person just gave us. It also
 * points a database at anyone who can type a plausible policy number into
 * WhatsApp, and that is the risk these tests exist for.
 *
 * A policy number is guessable and a DNI is not secret. So a lookup keyed on
 * either confirms what the caller already claimed — this policy exists, it is
 * in force — and volunteers nothing about the person behind it. The insured
 * vehicle is the one detail that identifies a household, and it is released
 * only once the DNI given matches the one on file.
 */

const rows: Record<string, unknown[]> = {};

/**
 * How many policies the tenant has, for the empty-book check.
 *
 * Separate from `rows.policies` on purpose: "this insurer has no policies at
 * all" and "this insurer has plenty, just not that one" are the two cases the
 * guard exists to tell apart, and a single fixture cannot express both.
 */
let policiesOnFile = 500;

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(() => chain()) },
}));

// Drizzle keeps the table name on a symbol; the mock reads it to decide what
// to answer, the same way the query would.
const DRIZZLE_NAME = Symbol.for("drizzle:Name");

function chain() {
  let name = "";
  const found = () => Promise.resolve(rows[name] ?? []);
  const joined = () => ({ where: () => ({ limit: found }) });

  return {
    from: (t: unknown) => {
      name = (t as Record<symbol, string>)[DRIZZLE_NAME] ?? "";
      return {
        leftJoin: joined,
        innerJoin: joined,
        // A bare where() with no join and no limit is one of two queries: the
        // policy count, or the vehicles on a policy.
        where: () =>
          name === "policies"
            ? Promise.resolve([{ n: policiesOnFile }])
            : found(),
      };
    },
  };
}

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTool, describeTools, AGENT_TOOLS } from "@/server/ai/agent-tools";

const CTX = {
  tenantId: "10000000-0000-0000-0000-000000000001",
  caseId: "11111111-1111-1111-1111-111111111111",
};

const FUTURE = "2099-01-01";
const PAST = "2020-01-01";

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(rows)) delete rows[key];
  policiesOnFile = 500;

  // clearAllMocks forgets calls, not implementations — and one test below
  // makes select() throw. Without this, every test after it inherits a broken
  // database.
  const { db } = await import("@/lib/db");
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => chain());
});

describe("verificar_poliza", () => {
  function policyOnFile(over: Record<string, unknown> = {}) {
    rows.policies = [
      {
        id: "pol-1",
        status: "active",
        type: "auto",
        endDate: FUTURE,
        holderDni: "30145882",
        ...over,
      },
    ];
  }

  it("says so when the number matches nothing", async () => {
    rows.policies = [];

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-0000-X" },
      CTX
    )) as Record<string, unknown>;

    expect(out.existe).toBe(false);
  });

  it("confirms a policy in force", async () => {
    policyOnFile();

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-4471-A" },
      CTX
    )) as Record<string, unknown>;

    expect(out).toMatchObject({ existe: true, vigente: true });
  });

  it("reports an expired policy as expired, with the date", async () => {
    // Worth its own case: asking someone for photographs of the damage when
    // their cover lapsed in 2020 wastes their afternoon and ours.
    policyOnFile({ endDate: PAST });

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-4471-A" },
      CTX
    )) as Record<string, unknown>;

    expect(out.vigente).toBe(false);
    expect(out.vencio_el).toBe(PAST);
  });

  it("treats a cancelled policy as not in force even with a future end date", async () => {
    policyOnFile({ status: "cancelled" });

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-4471-A" },
      CTX
    )) as Record<string, unknown>;

    expect(out.vigente).toBe(false);
  });

  it("never names the holder", async () => {
    // The disclosure that matters. Anyone can type a policy number.
    policyOnFile();

    const out = await runTool("verificar_poliza", { numero_poliza: "POL-4471-A" }, CTX);

    const text = JSON.stringify(out);
    expect(text).not.toContain("30145882");
    expect(Object.keys(out as object)).not.toContain("titular");
  });

  it("withholds the insured vehicle when no DNI was given", async () => {
    policyOnFile();
    rows.insured_assets = [{ make: "Fiat", model: "Uno", year: 2015, plate: "AB123CD" }];

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-4471-A" },
      CTX
    )) as Record<string, unknown>;

    expect(out.vehiculos).toBeUndefined();
    expect(out.titular_coincide).toBeNull();
  });

  it("withholds the insured vehicle when the DNI does not match", async () => {
    policyOnFile();
    rows.insured_assets = [{ make: "Fiat", model: "Uno", year: 2015, plate: "AB123CD" }];

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-4471-A", dni: "99999999" },
      CTX
    )) as Record<string, unknown>;

    expect(out.titular_coincide).toBe(false);
    expect(out.vehiculos).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("AB123CD");
  });

  it("describes the vehicle once the DNI matches", async () => {
    policyOnFile();
    rows.insured_assets = [{ make: "Fiat", model: "Uno", year: 2015, plate: "AB123CD" }];

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-4471-A", dni: "30.145.882" },
      CTX
    )) as Record<string, unknown>;

    expect(out.titular_coincide).toBe(true);
    expect(out.vehiculos).toEqual(["Fiat Uno 2015 patente AB123CD"]);
  });

  it("reads a DNI however the person punctuated it", async () => {
    policyOnFile();

    for (const written of ["30.145.882", "30145882", "DNI 30 145 882"]) {
      const out = (await runTool(
        "verificar_poliza",
        { numero_poliza: "POL-4471-A", dni: written },
        CTX
      )) as Record<string, unknown>;
      expect(out.titular_coincide, written).toBe(true);
    }
  });

  it("complains about a missing argument instead of guessing", async () => {
    const out = (await runTool("verificar_poliza", {}, CTX)) as Record<string, unknown>;
    expect(out.error).toContain("numero_poliza");
  });
});

describe("polizas_por_dni", () => {
  it("finds the policy so nobody has to be asked for its number", async () => {
    // The whole reason this tool exists: "soy Roberto Paz, DNI 25.888.101" and
    // the only move used to be asking for something we already hold.
    rows.policies = [{ number: "POL-3311-B", status: "active", type: "auto", endDate: FUTURE }];

    const out = (await runTool("polizas_por_dni", { dni: "25.888.101" }, CTX)) as {
      encontradas: number;
      polizas: Array<{ numero: string; vigente: boolean }>;
    };

    expect(out.encontradas).toBe(1);
    expect(out.polizas[0]).toMatchObject({ numero: "POL-3311-B", vigente: true });
  });

  it("distinguishes 'not on file' from 'wrong DNI'", async () => {
    rows.policies = [];

    const out = (await runTool("polizas_por_dni", { dni: "11111111" }, CTX)) as Record<
      string,
      unknown
    >;

    expect(out.encontradas).toBe(0);
    expect(out.nota).toBeTruthy();
  });

  it("refuses a DNI with no digits in it", async () => {
    const out = (await runTool("polizas_por_dni", { dni: "no me acuerdo" }, CTX)) as Record<
      string,
      unknown
    >;
    expect(out.error).toBeTruthy();
  });
});

describe("runTool", () => {
  it("answers rather than throwing when a tool does not exist", async () => {
    const out = (await runTool("borrar_todo", {}, CTX)) as Record<string, unknown>;
    expect(out.error).toContain("borrar_todo");
  });

  it("survives the database failing mid-lookup", async () => {
    // A failed lookup was optional; losing the whole deliberation over it
    // would cost the claimant their reply.
    const { db } = await import("@/lib/db");
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("connection lost");
    });

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-1" },
      CTX
    )) as Record<string, unknown>;

    expect(out.error).toBeTruthy();
  });
});

describe("the tool menu", () => {
  it("is all read-only, which is the safety argument", () => {
    // Every side effect travels through the validated plan instead. If a tool
    // that writes is ever added, this test should fail and someone should
    // think hard about it.
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "historial_del_caso",
      "polizas_por_dni",
      "verificar_poliza",
    ]);
  });

  it("tells the model what each one is for", () => {
    const menu = describeTools();
    for (const tool of AGENT_TOOLS) {
      expect(menu).toContain(tool.name);
      expect(menu).toContain(tool.description.slice(0, 30));
    }
  });
});

describe("an insurer that has not loaded its policies yet", () => {
  /**
   * Every pilot is in this state on day one, and the two situations are
   * indistinguishable to a query: an empty `policies` table answers "no such
   * policy" to every lookup. The agent, correctly, treats a policy that does
   * not exist as something a person should look at — so without this the first
   * morning of a pilot escalates every claim that arrives.
   */
  it("says the book is empty rather than that the policy is bogus", async () => {
    rows.policies = [];
    policiesOnFile = 0;

    const out = (await runTool(
      "verificar_poliza",
      { numero_poliza: "POL-4471-A" },
      CTX
    )) as Record<string, unknown>;

    expect(out.sin_datos).toBe(true);
    expect(out.existe).toBeUndefined();
  });

  it("says the same for a DNI search", async () => {
    rows.policies = [];
    policiesOnFile = 0;

    const out = (await runTool("polizas_por_dni", { dni: "30145882" }, CTX)) as Record<
      string,
      unknown
    >;

    expect(out.sin_datos).toBe(true);
    expect(out.encontradas).toBeUndefined();
  });
});
