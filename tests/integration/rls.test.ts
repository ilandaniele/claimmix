/**
 * RLS isolation integration tests.
 *
 * Verifies that Supabase Row Level Security prevents cross-tenant data access.
 *
 * AC9: GET /api/cases returns only the authenticated tenant's rows.
 * AC10: A case from another tenant returns 404 (not 403 — prevents enumeration).
 *
 * These tests require a running Supabase local instance (supabase start)
 * with the fixture data from tests/fixtures/tenants.sql applied.
 *
 * They are skipped unless RLS_INTEGRATION_ENABLED=true is set.
 *
 * To run locally:
 *   1. supabase start
 *   2. psql $(supabase status -o tsv | grep DB | awk '{print $2}') -f tests/fixtures/tenants.sql
 *   3. RLS_INTEGRATION_ENABLED=true vitest run tests/integration/rls.test.ts
 */

import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

type CaseRow = Database["public"]["Tables"]["cases"]["Row"];
type AuditRow = Database["public"]["Tables"]["audit_log"]["Row"];

const shouldSkip = !process.env.RLS_INTEGRATION_ENABLED;

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Test fixture UUIDs from tests/fixtures/tenants.sql
const T1_CASE_ID = "cccccccc-0000-0000-0000-000000000001";
const T2_CASE_ID = "dddddddd-0000-0000-0000-000000000001";
const U1_EMAIL = "u1@alfa.com";
const U2_EMAIL = "u2@beta.com";
const TEST_PASSWORD = "Test1234!";

describe.skipIf(shouldSkip)("RLS tenant isolation", () => {
  it("AC9: user U1 sees only T1 cases, not T2 cases", async () => {
    // Sign in as U1.
    const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: U1_EMAIL,
      password: TEST_PASSWORD,
    });
    expect(signInError).toBeNull();

    // Query cases.
    const { data: casesRaw, error } = await supabase.from("cases").select("*");
    const cases = casesRaw as CaseRow[] | null;
    expect(error).toBeNull();
    expect(cases).not.toBeNull();

    const ids = (cases ?? []).map((c) => c.id);
    expect(ids).toContain(T1_CASE_ID);
    expect(ids).not.toContain(T2_CASE_ID);

    // All returned cases belong to T1.
    const t1TenantId = "aaaaaaaa-0000-0000-0000-000000000001";
    for (const c of cases ?? []) {
      expect(c.tenant_id).toBe(t1TenantId);
    }

    await supabase.auth.signOut();
  });

  it("AC10: user U1 cannot read a T2 case by ID (RLS returns empty, not error)", async () => {
    const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
    await supabase.auth.signInWithPassword({
      email: U1_EMAIL,
      password: TEST_PASSWORD,
    });

    // Attempt to read T2's case directly by ID.
    const { data, error } = await supabase
      .from("cases")
      .select("*")
      .eq("id", T2_CASE_ID)
      .single();

    // RLS causes the row to be invisible — PostgREST returns an empty result.
    // With .single(), this manifests as an error with code 'PGRST116' (0 rows).
    expect(data).toBeNull();
    // Either no rows found (PGRST116) or data is null — both acceptable.
    if (error) {
      expect(["PGRST116", "not found"]).toContain(error.code ?? error.message);
    }

    await supabase.auth.signOut();
  });

  it("U2 sees only T2 cases, not T1 cases", async () => {
    const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
    await supabase.auth.signInWithPassword({
      email: U2_EMAIL,
      password: TEST_PASSWORD,
    });

    const { data: casesRaw2 } = await supabase.from("cases").select("*");
    const cases = casesRaw2 as CaseRow[] | null;
    const ids = (cases ?? []).map((c) => c.id);

    expect(ids).toContain(T2_CASE_ID);
    expect(ids).not.toContain(T1_CASE_ID);

    await supabase.auth.signOut();
  });

  it("audit_log is tenant-isolated: U1 cannot read T2 audit logs", async () => {
    const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
    await supabase.auth.signInWithPassword({
      email: U1_EMAIL,
      password: TEST_PASSWORD,
    });

    const { data: logsRaw } = await supabase
      .from("audit_log")
      .select("*");
    const logs = logsRaw as AuditRow[] | null;

    const t2TenantId = "aaaaaaaa-0000-0000-0000-000000000002";
    for (const log of logs ?? []) {
      expect(log.tenant_id).not.toBe(t2TenantId);
    }

    await supabase.auth.signOut();
  });
});
