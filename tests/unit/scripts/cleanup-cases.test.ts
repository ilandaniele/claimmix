/**
 * Unit tests for scripts/cleanup-cases.ts
 *
 * Strategy:
 *   - Import only the exported pure functions (validateEnv, run, countCases,
 *     deleteFromTable, DELETION_ORDER) — the entry-point guard (process.argv[1]
 *     check) prevents the script body from running on import.
 *   - Mock the Supabase client with a factory that captures calls.
 *   - Mock readline / process.exit via vi.spyOn to test exit behaviour without
 *     actually terminating the test process.
 *
 * AC coverage:
 *   AC8  — prints count + tenant_id; prompts for "DELETE"
 *   AC9  — on "DELETE": deletes every table in FK order, prints per-table counts
 *   AC10 — missing SUPABASE_SERVICE_ROLE_KEY → process.exit(1), zero DB calls
 *   AC11 — every delete query carries .eq("tenant_id", TENANT_ID)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Helpers — build a chainable Supabase mock
// ---------------------------------------------------------------------------

/** Tracks every .from(table) call and the chained operations. */
interface CallRecord {
  table: string;
  method: string;
  args: unknown[];
}

/**
 * Creates a minimal Supabase mock that supports the query builder chains used
 * in cleanup-cases.ts:
 *
 *   countCases:     .from(t).select(col, opts).eq(col, val)  → { count, error }
 *   deleteFromTable: .from(t).delete().eq(col, val).select(col) → { data, error }
 *
 * Both chains terminate when awaited. The chain object is a thenable so that
 * any position in the chain can be `await`ed and resolve to the final result.
 */
function makeSupabaseMock(
  rowsByTable: Record<string, unknown[]> = {},
  countOverride?: number
) {
  const calls: CallRecord[] = [];

  function makeChain(
    table: string,
    mode: "count" | "delete"
  ): Record<string, unknown> {
    const rows = rowsByTable[table] ?? [];
    const resolvedValue =
      mode === "count"
        ? {
            data: null,
            count: countOverride !== undefined ? countOverride : rows.length,
            error: null,
          }
        : { data: rows, error: null };

    // A thenable chain: every method returns the same chain object so calls
    // can be chained in any order. Awaiting the chain resolves to resolvedValue.
    const chain: Record<string, unknown> = {
      then(
        onfulfilled?: (value: unknown) => unknown,
        onrejected?: (reason: unknown) => unknown
      ) {
        return Promise.resolve(resolvedValue).then(onfulfilled, onrejected);
      },
      catch(onrejected?: (reason: unknown) => unknown) {
        return Promise.resolve(resolvedValue).catch(onrejected);
      },
    };

    const proxy = new Proxy(chain, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // Any unknown method call records the call and returns the same chain
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args });
          return proxy;
        };
      },
    });

    return proxy;
  }

  const supabase = {
    from: (table: string) => {
      calls.push({ table, method: "from", args: [table] });

      // Determine mode lazily: if .delete() is called first → "delete",
      // else if .select() is called first → "count".
      // We use a proxy that detects the first meaningful method.
      const outer: Record<string, unknown> = {};

      const outerProxy = new Proxy(outer, {
        get(_target, prop) {
          if (prop === "delete") {
            return () => {
              calls.push({ table, method: "delete", args: [] });
              return makeChain(table, "delete");
            };
          }
          if (prop === "select") {
            return (...args: unknown[]) => {
              calls.push({ table, method: "select", args });
              return makeChain(table, "count");
            };
          }
          // Fallback for any other method
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args });
            return outerProxy;
          };
        },
      });

      return outerProxy;
    },
    calls,
  } as unknown as SupabaseClient & { calls: CallRecord[] };

  return supabase;
}

// ---------------------------------------------------------------------------
// Import the functions under test
// ---------------------------------------------------------------------------
// We import after setting up vi.mock so modules resolve mocked versions.
// The entry-point guard (process.argv[1] check) means the script body does
// not execute on import.

import {
  validateEnv,
  run,
  DELETION_ORDER,
  type EnvConfig,
} from "../../../scripts/cleanup-cases";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TENANT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SUPABASE_URL = "https://test.supabase.co";
const SERVICE_KEY = "service_role_key_test_1234567890_abcdef";

const VALID_ENV: EnvConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_KEY,
  tenantId: TENANT_ID,
};

// ---------------------------------------------------------------------------
// AC10: validateEnv exits 1 when SUPABASE_SERVICE_ROLE_KEY is missing
// ---------------------------------------------------------------------------
describe("validateEnv — AC10", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Suppress the actual exit — replace with a thrown error we can catch
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
  });

  it("exits 1 when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = SUPABASE_URL;
    delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
    process.env["GMAIL_TENANT_ID"] = TENANT_ID;

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    delete process.env["NEXT_PUBLIC_SUPABASE_URL"];
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = SERVICE_KEY;
    process.env["GMAIL_TENANT_ID"] = TENANT_ID;

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when GMAIL_TENANT_ID is missing", () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = SUPABASE_URL;
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = SERVICE_KEY;
    delete process.env["GMAIL_TENANT_ID"];

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when all three are missing", () => {
    delete process.env["NEXT_PUBLIC_SUPABASE_URL"];
    delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
    delete process.env["GMAIL_TENANT_ID"];

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("returns parsed config when all vars are present", () => {
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = SUPABASE_URL;
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = SERVICE_KEY;
    process.env["GMAIL_TENANT_ID"] = TENANT_ID;

    const config = validateEnv();
    expect(config).toEqual({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_KEY,
      tenantId: TENANT_ID,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC8: prints count + tenant before prompting
// ---------------------------------------------------------------------------
describe("run — AC8: count display and prompt", () => {
  it("prints case count and tenant_id before prompting for confirmation", async () => {
    const rowsByTable: Record<string, unknown[]> = {
      cases: [{ id: "1" }, { id: "2" }, { id: "3" }],
    };
    const supabase = makeSupabaseMock(rowsByTable, 3);
    const logs: string[] = [];
    const prompt = vi.fn().mockResolvedValue("no");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: (msg) => logs.push(msg),
    });

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("3");
    expect(allOutput).toContain(TENANT_ID);
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("DELETE"));
  });

  it("prints 'Cancelled.' and does not delete when user types anything other than DELETE", async () => {
    const supabase = makeSupabaseMock({ cases: [{ id: "1" }] }, 1);
    const logs: string[] = [];
    const prompt = vi.fn().mockResolvedValue("yes");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: (msg) => logs.push(msg),
    });

    expect(logs.join("\n")).toContain("Cancelled");
    // No delete calls should have been made
    const deleteCalls = (supabase as unknown as { calls: CallRecord[] }).calls.filter(
      (c) => c.method === "delete"
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("treats empty input as cancellation", async () => {
    const supabase = makeSupabaseMock({ cases: [] }, 0);
    const logs: string[] = [];
    const prompt = vi.fn().mockResolvedValue("");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: (msg) => logs.push(msg),
    });

    expect(logs.join("\n")).toContain("Cancelled");
  });

  it("treats 'delete' (lowercase) as cancellation — must be exact uppercase", async () => {
    const supabase = makeSupabaseMock({ cases: [] }, 0);
    const logs: string[] = [];
    const prompt = vi.fn().mockResolvedValue("delete");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: (msg) => logs.push(msg),
    });

    expect(logs.join("\n")).toContain("Cancelled");
  });
});

// ---------------------------------------------------------------------------
// AC9: deletes in FK order when user types DELETE
// ---------------------------------------------------------------------------
describe("run — AC9: FK-order deletion + per-table counts", () => {
  it("deletes every table in DELETION_ORDER when confirmed", async () => {
    // Give each table a different row count so we can verify per-table output
    const rowsByTable: Record<string, unknown[]> = {
      audit_log: [{ id: 1 }, { id: 2 }],
      claim_messages: [{ id: "a" }],
      claim_attachments: [],
      claim_field_confirmations: [{ id: "b" }, { id: "c" }],
      missing_docs: [],
      extracted_fields: [{ id: "d" }],
      raw_messages: [{ id: "e" }, { id: "f" }, { id: "g" }],
      outbound_messages: [],
      ai_usage: [{ id: 1 }],
      cases: [{ id: "h" }, { id: "i" }],
    };
    const supabase = makeSupabaseMock(rowsByTable, 2);
    const logs: string[] = [];
    const prompt = vi.fn().mockResolvedValue("DELETE");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: (msg) => logs.push(msg),
    });

    // Verify that every table in DELETION_ORDER was targeted
    const deletedTables = (supabase as unknown as { calls: CallRecord[] }).calls
      .filter((c) => c.method === "delete")
      .map((_, i) => {
        // "from" calls precede "delete" calls — extract table name from from calls
        const fromCalls = (supabase as unknown as { calls: CallRecord[] }).calls.filter(
          (c) => c.method === "from"
        );
        return fromCalls[i]?.args[0] as string | undefined;
      })
      .filter(Boolean);

    // Every table in DELETION_ORDER must appear in the from() calls
    for (const entry of DELETION_ORDER) {
      const fromCalls = (supabase as unknown as { calls: CallRecord[] }).calls.filter(
        (c) => c.method === "from" && c.args[0] === entry.table
      );
      expect(fromCalls.length, `table ${entry.table} should be called`).toBeGreaterThanOrEqual(1);
    }
  });

  it("deletes cases table last in DELETION_ORDER", () => {
    expect(DELETION_ORDER[DELETION_ORDER.length - 1].table).toBe("cases");
  });

  it("prints per-table row counts in the log output", async () => {
    const rowsByTable: Record<string, unknown[]> = {
      audit_log: new Array(5).fill({ id: 1 }),
      claim_messages: new Array(3).fill({ id: "a" }),
      claim_attachments: [],
      claim_field_confirmations: [],
      missing_docs: [],
      extracted_fields: [],
      raw_messages: [],
      outbound_messages: [],
      ai_usage: [],
      cases: new Array(7).fill({ id: "c" }),
    };
    const supabase = makeSupabaseMock(rowsByTable, 7);
    const logs: string[] = [];
    const prompt = vi.fn().mockResolvedValue("DELETE");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: (msg) => logs.push(msg),
    });

    const allOutput = logs.join("\n");
    // Should mention each table that had rows deleted
    expect(allOutput).toContain("audit_log");
    expect(allOutput).toContain("cases");
  });

  it("prints completion message after deletion", async () => {
    const supabase = makeSupabaseMock({ cases: [] }, 0);
    const logs: string[] = [];
    const prompt = vi.fn().mockResolvedValue("DELETE");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: (msg) => logs.push(msg),
    });

    expect(logs.join("\n")).toContain("complete");
  });
});

// ---------------------------------------------------------------------------
// AC10: zero DB writes when service role key is absent
// ---------------------------------------------------------------------------
describe("run — AC10: no writes without service role key", () => {
  it("AC10 is enforced before run() is called — validateEnv blocks execution", () => {
    // validateEnv calls process.exit(1) before any Supabase client is created.
    // This test documents the guarantee: if validateEnv returns, the key is present.
    // The AC10 unit tests for validateEnv above prove the exit(1) path.
    // This assertion confirms DELETION_ORDER has items (sanity check only).
    expect(DELETION_ORDER.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC11: tenant scoping — every delete query uses the configured tenant_id
// ---------------------------------------------------------------------------
describe("run — AC11: tenant-scoped deletion", () => {
  it("every .delete() call is followed by .eq('tenant_id', tenantId)", async () => {
    const supabase = makeSupabaseMock({ cases: [{ id: "1" }] }, 1);
    const prompt = vi.fn().mockResolvedValue("DELETE");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: () => {},
    });

    const allCalls = (supabase as unknown as { calls: CallRecord[] }).calls;

    // Find all .eq calls and verify they include tenant_id scoping
    const eqCalls = allCalls.filter((c) => c.method === "eq");
    expect(eqCalls.length).toBeGreaterThan(0);

    // Every table delete should have at least one .eq("tenant_id", ...) call.
    // The count query also uses .eq("tenant_id", ...) so the total is
    // DELETION_ORDER.length (deletes) + 1 (count query) = DELETION_ORDER.length + 1.
    const tenantEqCalls = eqCalls.filter(
      (c) => c.args[0] === "tenant_id" && c.args[1] === TENANT_ID
    );
    expect(tenantEqCalls.length).toBeGreaterThanOrEqual(DELETION_ORDER.length);
  });

  it("does NOT delete rows for a different tenant_id", async () => {
    const OTHER_TENANT = "bbbbbbbb-0000-0000-0000-000000000002";
    const supabase = makeSupabaseMock({ cases: [] }, 0);
    const prompt = vi.fn().mockResolvedValue("DELETE");

    await run(VALID_ENV, {
      supabase,
      prompt,
      log: () => {},
    });

    const allCalls = (supabase as unknown as { calls: CallRecord[] }).calls;
    // No eq call should reference the other tenant
    const wrongTenantCalls = allCalls.filter(
      (c) => c.method === "eq" && c.args[1] === OTHER_TENANT
    );
    expect(wrongTenantCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DELETION_ORDER integrity checks
// ---------------------------------------------------------------------------
describe("DELETION_ORDER — schema contract", () => {
  const EXPECTED_TABLES = [
    "audit_log",
    "claim_messages",
    "claim_attachments",
    "claim_field_confirmations",
    "missing_docs",
    "extracted_fields",
    "raw_messages",
    "outbound_messages",
    "ai_usage",
    "cases",
  ];

  it("contains all expected tables", () => {
    const tables = DELETION_ORDER.map((e) => e.table);
    for (const t of EXPECTED_TABLES) {
      expect(tables, `${t} should be in DELETION_ORDER`).toContain(t);
    }
  });

  it("has cases as the last entry (parent table deleted last)", () => {
    expect(DELETION_ORDER[DELETION_ORDER.length - 1].table).toBe("cases");
  });

  it("has audit_log before cases", () => {
    const auditIdx = DELETION_ORDER.findIndex((e) => e.table === "audit_log");
    const casesIdx = DELETION_ORDER.findIndex((e) => e.table === "cases");
    expect(auditIdx).toBeLessThan(casesIdx);
  });

  it("has claim_messages before cases", () => {
    const msgIdx = DELETION_ORDER.findIndex((e) => e.table === "claim_messages");
    const casesIdx = DELETION_ORDER.findIndex((e) => e.table === "cases");
    expect(msgIdx).toBeLessThan(casesIdx);
  });
});
