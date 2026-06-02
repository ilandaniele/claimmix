# ADR 0002 — Single-tenant deploy, multi-tenant-ready schema

**Date:** 2026-06-02
**Status:** Accepted
**Deciders:** Senior Dev (ClaimMix crew)

## Context

The requirement specifies "self-hosted infrastructure for data privacy (insurer's data never
leaves their control)". This points toward one Supabase project per insurer (single-tenant
deploy). However, the data model should be ready for a future SaaS pivot without a schema
migration.

## Decision

- One Supabase project = one insurer (tenant) in MVP.
- Every domain table carries a `tenant_id uuid` column (NOT NULL on `cases`, `raw_messages`,
  etc.; nullable only on `tenants` and `users` themselves).
- RLS policies enforce `tenant_id = current_tenant_id()` on all domain tables.
- The `current_tenant_id()` helper is a Postgres function: `SELECT tenant_id FROM users WHERE id = auth.uid()`.
- No tenant-switcher UI ships in v1.

## Consequences

**Good:**
- Complete data isolation between insurers at the database level (row-level, not schema-level).
- Phase 2 SaaS: add a tenant switcher, route requests to the shared Supabase project, and
  the schema is already correct — no migration needed.
- Free-tier Supabase per insurer = $0 infra cost in MVP.

**Bad:**
- Each new insurer requires a manual Supabase project setup (documented in README).
- Shared Supabase project in phase 2 would require trusting RLS exclusively — no schema-level
  isolation. Acceptable for ASVS L2; not acceptable for ASVS L3 (highly regulated data).

## Constraint

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. It is used ONLY in:
1. The AI extraction worker (writes extracted_fields + audit_log as system actor).
2. `POST /api/admin/users` (creates auth users via Supabase Admin API).

Never exposed via `NEXT_PUBLIC_*` vars or injected into the LLM prompt.
