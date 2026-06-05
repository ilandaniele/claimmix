# QA Report: ClaimMix fix/email-extraction-fields — 2026-06-05

**Decision:** FAIL
**Stack:** Next.js 16 (Node 22) + Supabase Postgres + OpenAI gpt-4o-mini
**Branch:** fix/email-extraction-fields
**PR:** https://github.com/ilandaniele/claimmix/pull/30

---

## Build & install
- Status: not run (server-only fix; no new build artifacts required)
- TypeScript (`pnpm tsc --noEmit`): PASS — zero errors
- Lint (`pnpm lint --max-warnings=5`): PASS — 1 pre-existing warning (TanStack `useReactTable` memoization in CasesTable.tsx), 0 errors

## Unit + integration
- Pass/Total: 1359/1396 (37 skipped, 0 failed)
- Coverage: not re-measured for this targeted fix (existing gate ≥80% was passing before this PR; no coverage regression expected from server-only additions)
- Failed: none
- Skipped: 37 (pre-existing, gated on RLS_INTEGRATION_ENABLED / live Supabase)

New test files introduced and verified passing:

| File | Tests | Verdict |
|---|---|---|
| tests/unit/server/ai/prompt.test.ts | 26 | PASS |
| tests/unit/server/ai/hydrate-fields.test.ts | 52 | PASS |
| tests/unit/lib/i18n/i18n-parity.test.ts | 51 | PASS |
| tests/unit/server/worker/extract.email.bugfix.test.ts | 7 | PASS |
| tests/unit/server/worker/extract.email.security.test.ts | 4 | PASS |

## Startup & healthcheck
- N/A — this PR contains no server startup or routing changes.

## Endpoint smoke
- N/A — no new public endpoints introduced; existing endpoint signatures unchanged.

## Runtime security

| Check | Result |
|---|---|
| CORS allowed origin echoed | N/A (unchanged) |
| CORS disallowed origin blocked | N/A (unchanged) |
| HSTS / X-CTO / X-Frame / CSP / Referrer-Policy | N/A (unchanged) |
| X-Powered-By absent | N/A (unchanged) |
| JWT abuse (expired/malformed/missing → 401) | N/A (no new endpoints) |
| Rate limit triggers 429 by request 6 | N/A (checkBudget gate unchanged) |
| RLS: user A cannot read user B | N/A (RLS policies unchanged) |
| Wrong-owner returns 404 (not 403) | N/A (no new endpoints) |

### SEC-1 — No PII in new structured logs
- Check: `git diff` grep for new console.log/info/warn/error calls containing dni/full_name/policy_number
- Result: PASS — zero hits. Structured log at `email_worker.extraction_complete` emits only: case_id, is_claim, severity, new_status, customer_matched, policy_matched, missing_fields_count, model.

### SEC-2 — PII scrub test ("summary does not contain DNI after scrub")
- `tests/unit/server/worker/extract.email.security.test.ts > SEC-2: scrubPiiFromSummary removes DNI '92310691' from summary`
- Result: PASS

### SEC-3 — XML sentinels intact
- `<email_subject>` present at line 290
- `<email_body>` present at lines 292–294
- Result: PASS

### SEC-4 — No new dependencies added
- `git diff origin/main...fix/email-extraction-fields -- package.json pnpm-lock.yaml`: empty diff
- Result: PASS

## Hydration order check (Runtime sanity)
- `hydrateFieldsFromExtracted` called at line 479 of `src/server/worker/extract.ts`
- `HIGH_CONFIDENCE_THRESHOLD` defined at line 534
- Hydration line (479) < threshold line (534): PASS

## i18n key collision check
- All 8 new `field.*` keys present once each in es-AR.ts (lines 132–139) and en-US.ts (lines 129–136)
- No duplicate keys detected
- Legacy keys (field.date, field.location, field.party_a_name, etc.) remain intact (AC13 regression)
- Result: PASS

## Deployment validation

### .env.example
- No changes to `.env.example` (empty diff) — PASS. No new env vars were added.

### package.json scripts
- No changes to `package.json` (empty diff) — PASS.

## E2E
- Playwright E2E: not in scope per spec.md ("E2E — out of scope for this fix")
- Existing dashboard E2E suite remains unchanged and green per CI run.

## Lighthouse CI / Bundle size / Stress / Pen tests
- N/A per spec.md: server-only change + 8 i18n strings; no frontend bundle impact.

## Supply chain / SAST

| Check | Status |
|---|---|
| CodeQL workflow present (.github/workflows/codeql.yml) | present |
| SBOM workflow | not checked (out of scope for this fix) |

## CI run observation (Step 7f — MANDATORY)

Latest CI run on branch: run ID 26997140036 (CI workflow) + 26997140046 (CodeQL workflow).

| CI Job | Result |
|---|---|
| Build | PASS |
| Type check | PASS |
| Lint | PASS |
| Unit tests | PASS |
| Integration tests | PASS |
| Integration tests (Gmail polling) | PASS |
| E2E tests (Playwright) | PASS |
| Bundle size check | PASS |
| Security audit | PASS |
| License audit | PASS |
| CodeQL analysis (JavaScript/TypeScript) | PASS |
| Vercel deployment | PASS |
| Supabase Preview | SKIPPED (expected) |

### BLOCKING: CodeQL security alert — HIGH severity

**Check run ID:** 79669235245
**Status:** FAILURE — "1 new alert including 1 high severity security vulnerability"

**File:** `src/server/ai/hydrate-fields.ts`
**Line:** 126
**Rule:** Incomplete string escaping or encoding (CWE-116)
**Message:** "This does not escape backslash characters in the input."

**Affected code (line 126):**
```typescript
new RegExp(dniValue.replace(/[.]/g, "\\."), "g"),
```

**Root cause:** The DNI value is used directly in a `RegExp` constructor after only escaping dots. Backslash characters in `dniValue` are not escaped. If a DNI value contains a backslash (e.g. from malformed input passing the `^\d[\d.]*$` guard — note the guard passes values like digits and dots but a regex-special character backslash would be filtered by the guard), CodeQL conservatively flags this as incomplete escaping. The fix is to use the full special-character escape pattern `/[.*+?^${}()|[\]\\]/g` (already used correctly at lines 119 and 134 of the same file), replacing the partial `/[.]/g` at line 126.

**Impact:** Low exploitability in practice (the `/^\d[\d.]*$/` guard on line 124 restricts dniValue to digits and dots). However, CodeQL rates it HIGH and it is a CI job concluding "failure" — per QA rules this is BLOCKING.

**Recommended fix:**
```typescript
// Before (line 126):
new RegExp(dniValue.replace(/[.]/g, "\\."), "g"),

// After:
new RegExp(dniValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
```

Note: The subsequent CodeQL analysis run (26997140046) shows PASS for "CodeQL analysis (JavaScript/TypeScript)" because it is the full CodeQL SAST analysis job — the FAILURE is from the GitHub Advanced Security "CodeQL" check-suite result (check run ID 79669235245) which reports new SARIF alerts introduced by the PR diff. Both reference the same alert.

## LLM security (uses_llm = true)

| Probe | Result |
|---|---|
| Prompt injection refused (AC10: is_claim=true preserved) | PASS |
| Schema validation gate still active (malformed model output rejected) | PASS |
| PII not written to server logs (AC11) | PASS |
| System prompt leak: XML sentinels intact | PASS |
| DNI scrub from summary (scrubPiiFromSummary) | PASS |

Runtime LLM probes (Steps 5f) not executed — no live server / OPENAI_API_KEY in test environment. Covered by Vitest unit tests above.

## Mutation testing
- Not enabled (`mutation_testing` not set in state.json) — SKIPPED

## Pact contract tests
- Not enabled — SKIPPED

---

## Summary

| Category | Status |
|---|---|
| Unit + integration tests (1359/1396) | PASS |
| TypeScript type check | PASS |
| Lint (0 errors) | PASS |
| SEC-1: No PII in new log calls | PASS |
| SEC-2: DNI scrub test passes | PASS |
| SEC-3: XML sentinel tags intact | PASS |
| SEC-4: No new dependencies | PASS |
| Hydration order (before threshold filter) | PASS |
| i18n key parity (8 keys, no collisions) | PASS |
| .env.example unchanged | PASS |
| CI all jobs green | FAIL |
| CodeQL HIGH alert (line 126 hydrate-fields.ts) | **BLOCKING** |

**BLOCKING failures: 1**
- CodeQL HIGH: Incomplete string escaping in `src/server/ai/hydrate-fields.ts:126` — DNI regex only escapes dots, not all regex special characters. Fix: replace `/[.]/g` with `/[.*+?^${}()|[\]\\]/g` on that line.

**Non-blocking issues: 0**

**Decision: FAIL**

The fix is a one-line change. All other checks pass cleanly. Recommend fixing line 126 and re-pushing.
