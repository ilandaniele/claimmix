/**
 * Unit tests for the customer matcher.
 *
 * AC6:  High-confidence match sets customer_id + policy_id.
 * AC22: Match priority — policy_number > dni > email > phone.
 *
 * Uses a mocked Drizzle db to avoid real DB calls.
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
    customers: { id: "id", full_name: "full_name", email: "email", dni: "dni", tenant_id: "tenant_id" },
    customerContacts: { customer_id: "customer_id", tenant_id: "tenant_id", contact_type: "contact_type", value: "value" },
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import type { ClaimFields } from "@/lib/schemas/extracted-claim";
import { db } from "@/lib/db";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TENANT_ID = "10000000-0000-0000-0000-000000000001";

const CUSTOMER_A = {
  id: "20000000-0000-0000-0000-000000000001",
  full_name: "Juan Pérez",
  email: "juan@example.com",
  dni: "12345678",
};

// Policy row as returned by the leftJoin projection:
// { id, customer_id, customer: { id, full_name, email, dni } }
const POLICY_A_ROW = {
  id: "30000000-0000-0000-0000-000000000001",
  customer_id: CUSTOMER_A.id,
  customer: CUSTOMER_A,
};

// ── Helper: build a select chain that resolves to given rows at .limit() ──────

function makeSelectChain(rows: unknown[]): any {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

// ── Policy number match ────────────────────────────────────────────────────────

describe("findCustomerMatches — policy_number match", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns high-confidence match (0.95) when policy_number matches", async () => {
    // Only one db.select call: matchByPolicyNumber
    vi.mocked(db.select).mockReturnValue(makeSelectChain([POLICY_A_ROW]) as any);

    const fields: Partial<ClaimFields> = { policy_number: "POL-1234" };
    const matches = await findCustomerMatches(TENANT_ID, fields);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const policyMatch = matches.find((m) => m.matchType === "policy_number");
    expect(policyMatch).toBeDefined();
    expect(policyMatch!.confidence).toBe(0.95);
    expect(policyMatch!.customerId).toBe(CUSTOMER_A.id);
    expect(policyMatch!.policyId).toBe(POLICY_A_ROW.id);
  });
});

// ── DNI match ──────────────────────────────────────────────────────────────────

describe("findCustomerMatches — DNI match", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns medium-high confidence (0.85) for DNI match", async () => {
    // matchByDni: db.select().from(c).where().limit() → [CUSTOMER_A]
    vi.mocked(db.select).mockReturnValue(makeSelectChain([CUSTOMER_A]) as any);

    const fields: Partial<ClaimFields> = { dni: "12345678" };
    const matches = await findCustomerMatches(TENANT_ID, fields);

    const dniMatch = matches.find((m) => m.matchType === "dni");
    expect(dniMatch).toBeDefined();
    expect(dniMatch!.confidence).toBe(0.85);
    expect(dniMatch!.customerId).toBe(CUSTOMER_A.id);
  });
});

// ── Email match ────────────────────────────────────────────────────────────────

describe("findCustomerMatches — email match", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns medium confidence (0.75) for email match", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([CUSTOMER_A]) as any);

    const fields: Partial<ClaimFields> = { email: "juan@example.com" };
    const matches = await findCustomerMatches(TENANT_ID, fields);

    const emailMatch = matches.find((m) => m.matchType === "email");
    expect(emailMatch).toBeDefined();
    expect(emailMatch!.confidence).toBe(0.75);
    expect(emailMatch!.customerId).toBe(CUSTOMER_A.id);
  });
});

// ── No match ───────────────────────────────────────────────────────────────────

describe("findCustomerMatches — no match", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no fields provided", async () => {
    const matches = await findCustomerMatches(TENANT_ID, {});
    expect(matches).toEqual([]);
    // db.select should never be called when no fields are provided
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns empty array when no customer matches found in DB", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const fields: Partial<ClaimFields> = { email: "unknown@example.com", dni: "99999999" };
    const matches = await findCustomerMatches(TENANT_ID, fields);
    expect(matches).toEqual([]);
  });
});

// ── Match priority: policy > dni > email ──────────────────────────────────────

describe("findCustomerMatches — match priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("policy match has highest confidence (0.95), sorted first", async () => {
    // Three fields provided: policy_number, dni, email → three db.select calls
    // Call 1: matchByPolicyNumber → [POLICY_A_ROW]
    // Call 2: matchByDni → [CUSTOMER_A]
    // Call 3: matchByEmail → [CUSTOMER_A]
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([POLICY_A_ROW]) as any)
      .mockReturnValueOnce(makeSelectChain([CUSTOMER_A]) as any)
      .mockReturnValueOnce(makeSelectChain([CUSTOMER_A]) as any);

    const fields: Partial<ClaimFields> = {
      policy_number: "POL-1234",
      dni: "12345678",
      email: "juan@example.com",
    };

    const matches = await findCustomerMatches(TENANT_ID, fields);

    // Sorted by confidence desc — policy (0.95) > dni (0.85) > email (0.75)
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.confidence).toBe(0.95);
    expect(matches[0]!.matchType).toBe("policy_number");
  });

  /*
   * Este test se llamaba «el match por DNI (0.85) va primero» y no lo probaba.
   *
   * Devolvía la MISMA persona por DNI y por correo, así que la deduplicación
   * las juntaba en una sola y el `if (matches.length >= 2)` que envolvía la
   * comparación nunca se cumplía. Lo único que quedaba en pie era
   * `expect(first).toBeDefined()`: un test de ranking que sólo comprobaba que
   * hubiera algo.
   *
   * Para que haya ranking tiene que haber dos personas distintas. Con una sola
   * no hay nada que ordenar, y eso ahora se afirma aparte, abajo.
   */
  it("when no policy match, DNI match (0.85) ranks first", async () => {
    // Dos personas DISTINTAS: una aparece por DNI, la otra por correo. Sin eso
    // la deduplicación las junta y no queda orden que comprobar.
    const POR_CORREO = {
      id: "20000000-0000-0000-0000-000000000009",
      full_name: "Otra Persona",
      email: "juan@example.com",
      dni: "99999999",
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([CUSTOMER_A]) as any) // matchByDni
      .mockReturnValueOnce(makeSelectChain([POR_CORREO]) as any); // matchByEmail

    const fields: Partial<ClaimFields> = {
      dni: "12345678",
      email: "juan@example.com",
    };

    const matches = await findCustomerMatches(TENANT_ID, fields);

    // Sin `if`: que vengan las dos, en este orden, y con estas confianzas.
    expect(matches).toHaveLength(2);
    expect(matches[0]!.customerId).toBe(CUSTOMER_A.id);
    expect(matches[0]!.confidence).toBe(0.85);
    expect(matches[1]!.customerId).toBe(POR_CORREO.id);
    expect(matches[1]!.confidence).toBe(0.75);
  });

  it("la misma persona encontrada por DNI y por correo es UNA sola", async () => {
    /*
     * La otra mitad, que era lo que el test de arriba hacía sin querer: si los
     * dos caminos dan con la misma persona, sale una vez y con la confianza más
     * alta de las dos. Sin esto, arreglar el de arriba habría dejado la
     * deduplicación sin ninguna afirmación.
     */
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([CUSTOMER_A]) as any)
      .mockReturnValueOnce(makeSelectChain([CUSTOMER_A]) as any);

    const matches = await findCustomerMatches(TENANT_ID, {
      dni: "12345678",
      email: "juan@example.com",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.customerId).toBe(CUSTOMER_A.id);
    expect(matches[0]!.confidence).toBe(0.85);
  });
});

// ── Conflict detection ────────────────────────────────────────────────────────

describe("findCustomerMatches — conflict detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects conflicting full_name between extracted and stored customer", async () => {
    const customerWithDifferentName = {
      ...CUSTOMER_A,
      full_name: "Pedro García",
    };

    vi.mocked(db.select).mockReturnValue(makeSelectChain([customerWithDifferentName]) as any);

    const fields: Partial<ClaimFields> = {
      email: "juan@example.com",
      full_name: "Juan Pérez", // Different from stored "Pedro García"
    };

    const matches = await findCustomerMatches(TENANT_ID, fields);
    const emailMatch = matches.find((m) => m.matchType === "email");
    expect(emailMatch).toBeDefined();
    // Should detect full_name conflict
    expect(emailMatch!.conflictsWithExtracted).toContain("full_name");
  });

  it("returns empty conflictsWithExtracted when names match", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([CUSTOMER_A]) as any);

    const fields: Partial<ClaimFields> = {
      email: "juan@example.com",
      full_name: "Juan Pérez", // Same as stored
    };

    const matches = await findCustomerMatches(TENANT_ID, fields);
    const emailMatch = matches.find((m) => m.matchType === "email");
    expect(emailMatch).toBeDefined();
    expect(emailMatch!.conflictsWithExtracted).toEqual([]);
  });
});

// ── DB error handling ─────────────────────────────────────────────────────────

describe("findCustomerMatches — DB error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when DB returns error", async () => {
    const errorChain: any = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(
        Object.assign(new Error("DB error"), { code: "PGRST001", message: "DB error" })
      ),
    };
    vi.mocked(db.select).mockReturnValue(errorChain as any);

    const fields: Partial<ClaimFields> = { policy_number: "POL-9999" };
    // Should not throw — returns empty array
    const matches = await findCustomerMatches(TENANT_ID, fields);
    expect(Array.isArray(matches)).toBe(true);
  });
});

// ── El log dice con qué se pudo buscar, y nunca con qué valores ──────────────

describe("el log de customer_matcher", () => {
  /*
   * Un `match_count: 0` tiene dos causas que en el log se veían igual: la
   * persona no está en el padrón, o no teníamos por dónde buscarla. Son
   * problemas distintos y distinguirlos costó leer el código del extractor.
   */
  it("nombra las claves disponibles cuando no encuentra a nadie", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);
    const dichos: string[] = [];
    const espia = vi.spyOn(console, "info").mockImplementation((...a) => {
      dichos.push(a.map(String).join(" "));
    });

    await findCustomerMatches(TENANT_ID, { dni: "12345678", phone: "+5491100000000" });

    espia.mockRestore();
    const linea = dichos.find((d) => d.includes("customer_matcher.matches_found"))!;
    const log = JSON.parse(linea);

    expect(log.match_count).toBe(0);
    expect(log.claves_disponibles).toEqual(["dni", "phone"]);
  });

  it("NUNCA pone los valores en el log", async () => {
    // Un DNI y un teléfono no van a un log. La lista de qué campos había, sí.
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);
    const dichos: string[] = [];
    const espia = vi.spyOn(console, "info").mockImplementation((...a) => {
      dichos.push(a.map(String).join(" "));
    });

    await findCustomerMatches(TENANT_ID, {
      dni: "12345678",
      phone: "+5491100000000",
      email: "cecilia@example.com",
    });

    espia.mockRestore();
    const todo = dichos.join("\n");
    expect(todo).not.toContain("12345678");
    expect(todo).not.toContain("5491100000000");
    expect(todo).not.toContain("cecilia@example.com");
  });

  it("con el diccionario vacío la lista viene vacía, no con claves inventadas", async () => {
    const dichos: string[] = [];
    const espia = vi.spyOn(console, "info").mockImplementation((...a) => {
      dichos.push(a.map(String).join(" "));
    });

    await findCustomerMatches(TENANT_ID, {});

    espia.mockRestore();
    const log = JSON.parse(dichos.find((d) => d.includes("matches_found"))!);
    expect(log.claves_disponibles).toEqual([]);
  });
});

// ── Cómo escribe la gente, contra cómo lo guarda la base ─────────────────────

/**
 * Los parámetros con los que se consultó de verdad.
 *
 * Los buscadores pasaron de `eq(columna, valor)` a una expresión con
 * `regexp_replace`, así que el valor ya no es el argumento crudo: es el
 * normalizado. Se compila el `sql` con el mismo dialecto que usa la aplicación
 * en vez de hurgar los `queryChunks` a mano — mi primera versión leyó los
 * trozos de texto del SQL y afirmó sobre ellos, que no es lo que viaja.
 *
 * De paso queda visible que Drizzle PARAMETRIZA: el SQL sale con `$1` y el
 * valor va aparte, así que interpolar un dato de una persona acá no es una
 * inyección. Está comprobado abajo, no supuesto.
 */
function parametrosDeLaConsulta(chain: any): string[] {
  const arg = chain.where.mock.calls[0]?.[0];
  if (!arg) return [];
  return new PgDialect().sqlToQuery(arg).params.map(String);
}

/** El SQL compilado, para poder afirmar que el valor NO está pegado adentro. */
function sqlDeLaConsulta(chain: any): string {
  const arg = chain.where.mock.calls[0]?.[0];
  return arg ? new PgDialect().sqlToQuery(arg).sql : "";
}

describe("los buscadores normalizan los dos lados", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("un DNI con puntos busca por los dígitos", async () => {
    /*
     * Ésta es la falla que descubrió el ensayo: la base guarda `27654321` y la
     * persona escribe `27.654.321`, como se escribe un DNI acá. Con la igualdad
     * exacta que había antes, no aparecía en nuestro propio padrón.
     */
    const chain = makeSelectChain([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    await findCustomerMatches(TENANT_ID, { dni: "27.654.321" });

    expect(parametrosDeLaConsulta(chain)).toContain("27654321");
  });

  it("un número de póliza con espacios y en minúscula también", async () => {
    const chain = makeSelectChain([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    await findCustomerMatches(TENANT_ID, { policy_number: "pol 8812-r" });

    expect(parametrosDeLaConsulta(chain)).toContain("POL8812-R");
  });

  it("un teléfono con prefijo y guiones busca por los dígitos", async () => {
    // Antes se calculaba el normalizado y se tiraba: `void normalized`.
    const chain = makeSelectChain([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    await findCustomerMatches(TENANT_ID, { phone: "+54 9 11 0000-0000" });

    expect(parametrosDeLaConsulta(chain)).toContain("5491100000000");
  });

  it("una dirección en mayúsculas busca en minúsculas", async () => {
    const chain = makeSelectChain([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    await findCustomerMatches(TENANT_ID, { email: "  Cecilia@Example.COM " });

    expect(parametrosDeLaConsulta(chain)).toContain("cecilia@example.com");
  });

  it("el valor viaja como parámetro, no pegado al SQL", async () => {
    /*
     * Interpolar un dato que escribió una persona adentro de un `sql` se parece
     * a una inyección. No lo es —Drizzle lo saca a `$1`— y esto lo afirma en vez
     * de dejarlo a la confianza, porque el día que deje de ser cierto hay que
     * enterarse acá y no en producción.
     */
    const chain = makeSelectChain([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    await findCustomerMatches(TENANT_ID, { policy_number: "X' OR '1'='1" });

    expect(sqlDeLaConsulta(chain)).toContain("$1");
    expect(sqlDeLaConsulta(chain)).not.toContain("OR '1'='1");
    expect(parametrosDeLaConsulta(chain)).toContain("X'OR'1'='1");
  });

  it("un DNI que no son dígitos NO consulta, y no encuentra a cualquiera", async () => {
    /*
     * La mitad peligrosa de normalizar. Un `"s/d"` se convierte en la cadena
     * vacía, y buscar por vacío contra una columna normalizada devuelve a TODA
     * persona con el documento vacío — con la confianza alta de una
     * coincidencia por documento. Encontrar a cualquiera es peor que no
     * encontrar a nadie.
     */
    const chain = makeSelectChain([{ id: "x", full_name: "Quien Sea", email: null, dni: null }]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    const matches = await findCustomerMatches(TENANT_ID, { dni: "s/d" });

    expect(matches).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("un teléfono demasiado corto tampoco consulta", async () => {
    const chain = makeSelectChain([{ customer_id: "x", customer: null }]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    const matches = await findCustomerMatches(TENANT_ID, { phone: "123" });

    expect(matches).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});
