/**
 * Unit tests for the policy matcher.
 *
 * AC6:  Policy number match returns high confidence (0.95 for active).
 * AC22: Policy match has highest confidence.
 */

// vi.mock must be hoisted before any imports that trigger @/lib/db
// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  },
  tables: {
    policies: { id: "id", policy_number: "policy_number", policy_type: "policy_type", status: "status", tenant_id: "tenant_id", customer_id: "customer_id" },
    customers: { id: "id", full_name: "full_name", tenant_id: "tenant_id" },
  },
}));

import { QueryBuilder } from "drizzle-orm/pg-core";
import { policies } from "@/lib/db/schema";
import { armarFiltroDePolizas, type PolicyQuery } from "@/server/policies/list";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findPolicyMatches } from "@/server/matching/policy-matcher";
import { db } from "@/lib/db";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const CUSTOMER_ID = "20000000-0000-0000-0000-000000000001";

// These rows match what the db query returns after leftJoin + column projection:
// { id, policy_number, policy_type, status, customer_full_name }
const ACTIVE_POLICY_ROW = {
  id: "30000000-0000-0000-0000-000000000001",
  policy_number: "POL-1234",
  policy_type: "auto",
  status: "active",
  customer_full_name: "Juan Pérez",
};

const EXPIRED_POLICY_ROW = {
  id: "30000000-0000-0000-0000-000000000002",
  policy_number: "POL-OLD-9999",
  policy_type: "auto",
  status: "expired",
  customer_full_name: "Juan Pérez",
};

// ── Helper: build a select chain that resolves to given rows ──────────────────

function makeSelectChain(rows: unknown[]): any {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

// ── Exact policy_number match ──────────────────────────────────────────────────

describe("findPolicyMatches — policy_number exact match", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns match with confidence 0.95 for active policy", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([ACTIVE_POLICY_ROW]) as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-1234");

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const match = matches[0]!;
    expect(match.policyId).toBe(ACTIVE_POLICY_ROW.id);
    expect(match.policyNumber).toBe("POL-1234");
    expect(match.confidence).toBe(0.95);
    expect(match.status).toBe("active");
  });

  it("returns lower confidence (0.70) for expired policy by policy_number", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([EXPIRED_POLICY_ROW]) as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-OLD-9999");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const match = matches.find((m) => m.policyNumber === "POL-OLD-9999");
    expect(match).toBeDefined();
    expect(match!.confidence).toBe(0.70);
    expect(match!.status).toBe("expired");
  });

  it("returns empty array when policy_number not found", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-NOTFOUND");
    expect(matches).toEqual([]);
  });
});

// ── Customer-based policy lookup ───────────────────────────────────────────────

describe("findPolicyMatches — customer-based lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all active policies for a customer", async () => {
    const customerPolicies = [
      ACTIVE_POLICY_ROW,
      { ...ACTIVE_POLICY_ROW, id: "30000000-0000-0000-0000-000000000003", policy_number: "POL-5678" },
    ];

    vi.mocked(db.select).mockReturnValue(makeSelectChain(customerPolicies) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    for (const m of matches) {
      expect(m.confidence).toBeGreaterThan(0);
    }
  });

  it("returns lower confidence (0.60) for inactive policies via customer lookup", async () => {
    const cancelledRow = {
      ...ACTIVE_POLICY_ROW,
      id: "30000000-0000-0000-0000-000000000004",
      policy_number: "POL-CANCELLED",
      status: "cancelled",
    };

    vi.mocked(db.select).mockReturnValue(makeSelectChain([cancelledRow]) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);
    const cancelled = matches.find((m) => m.status === "cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled!.confidence).toBe(0.60);
  });

  it("returns empty array when customer has no policies", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);
    expect(matches).toEqual([]);
  });
});

// ── Active policies sorted first ──────────────────────────────────────────────

describe("findPolicyMatches — sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /*
   * Este test tenía el cuerpo entero adentro de dos `if` anidados
   * —`if (matches.length >= 2)` y `if (activeIdx !== -1 && expiredIdx !== -1)`—
   * y por lo tanto pasaba con una función que devolviera `[]`. Se llamaba
   * «ordena activas antes que vencidas» y no comprobaba que devolviera nada.
   *
   * Sin `if`: primero que estén las dos, después el orden.
   */
  it("sorts active policies before expired when using customer lookup", async () => {
    const mixed = [EXPIRED_POLICY_ROW, ACTIVE_POLICY_ROW]; // expired first in DB result

    vi.mocked(db.select).mockReturnValue(makeSelectChain(mixed) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);

    // Las dos vuelven: perder una es otra forma de «ordenar bien».
    expect(matches.map((m) => m.status)).toEqual(["active", "expired"]);
    expect(matches[0]!.policyId).toBe(ACTIVE_POLICY_ROW.id);
    expect(matches[1]!.policyId).toBe(EXPIRED_POLICY_ROW.id);

    // Y que el orden lo dio el estado y no la casualidad del arreglo: la base
    // las devolvió al revés.
    expect(mixed[0]).toBe(EXPIRED_POLICY_ROW);
  });
});

// ── No input returns empty ─────────────────────────────────────────────────────

describe("findPolicyMatches — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no policyNumber or customerId provided", async () => {
    // db.select should never be called in this path
    const matches = await findPolicyMatches(TENANT_ID);
    expect(matches).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("handles DB error gracefully and returns empty array", async () => {
    // Make the chain throw at the terminal .limit() step
    const errorChain: any = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(Object.assign(new Error("DB error"), { code: "DB_ERROR" })),
    };
    vi.mocked(db.select).mockReturnValue(errorChain as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-ERROR");
    expect(Array.isArray(matches)).toBe(true);
  });
});

/*
 * El filtro de `/api/policies`, que comparaba el número crudo.
 *
 * `normalizar.ts` avisa, en mayúsculas, que si el criterio cambia hay que
 * cambiar TAMBIÉN el lado SQL de los tres buscadores. Este era un cuarto lugar
 * que nadie contó: `?policy_number=pol-4471-a` no encontraba lo que el agente
 * sí encuentra, y los números de póliza los tipea una persona.
 */
describe("el filtro de /api/policies", () => {
  const sqlDe = (query: Partial<PolicyQuery>) => {
    const { sql: texto, params } = new QueryBuilder()
      .select()
      .from(policies)
      .where(armarFiltroDePolizas({ page: 1, per_page: 25, ...query }))
      .toSQL();
    return { texto, params };
  };

  it("el número en minúsculas y con espacios encuentra igual", () => {
    const { texto, params } = sqlDe({ policy_number: "pol - 4471 - a" });

    expect(texto.toLowerCase()).toContain("upper");
    expect(texto.toLowerCase()).toContain("replace");
    expect(params).toContain("POL-4471-A");
  });

  it("el guion viaja de los dos lados, o de ninguno", () => {
    /*
     * La regla que `normalizar.ts` documenta y que no se puede aflojar acá sola:
     * `POL-8812-R` y `POL8812R` pueden ser dos contratos distintos del mismo
     * inquilino, y el índice único es sobre el texto crudo. Si alguien saca el
     * guion en la función pero no en los cuatro sitios SQL, se rompen todas las
     * búsquedas de póliza en silencio.
     */
    const { texto, params } = sqlDe({ policy_number: "POL-8812-R" });

    expect(params).toContain("POL-8812-R");
    expect(params).not.toContain("POL8812R");
    // El SQL saca espacios, no guiones.
    expect(texto).toContain("' '");
  });
});
