# Code Review: ClaimMix — fix/email-extraction-fields — 2026-06-05

**Decision:** APPROVED
**Blocking:** 0 · **Non-blocking:** 3 · **Nits:** 3
**Confidence gate:** all findings are ≥80% certain. No BLOCKING findings.

---

## Acceptance criteria coverage

| Criterion | Status | Evidence (file:line / test) |
|---|---|---|
| AC1 — full_name in both shapes ≥0.85 | Covered | `hydrate-fields.test.ts` UNIT-3; `extract.email.bugfix.test.ts` INT-1 |
| AC2 — DNI in both shapes, NOT redacted | Covered | `hydrate-fields.test.ts` UNIT-3; `extract.email.security.test.ts` SEC-2 verifies extracted_fields.dni untouched |
| AC3 — email in both shapes | Covered | `extract.email.bugfix.test.ts` INT-1 (email row assertion) |
| AC4 — policy_number in both shapes | Covered | `extract.email.bugfix.test.ts` INT-1 (policy_number row assertion) |
| AC5 — fields persist to DB ≥0.85 | Covered | INT-1: all upserted fields have confidence >= HIGH_CONFIDENCE_THRESHOLD |
| AC6 — Spanish labels in ExtractedFieldsTable | Covered | `i18n-parity.test.ts` UNIT-2 (exact label assertions for all 8 keys) |
| AC7 — severity >= medium via context cues | Covered | `prompt.test.ts` verifies CONTEXT CUES section present; `classifySeverity` defaults to medium for claims |
| AC8 — no deescalation by missing keywords | Covered | `severity-classifier.test.ts` line 181 |
| AC9 — i18n keys in both locales | Covered | `i18n-parity.test.ts` (all 8 keys, both locales, parity check) |
| AC10 — injection containment intact | Covered | `extract.email.security.test.ts` SEC-1; schema rejects string is_claim |
| AC11 — PII not in summary/suggested_reply | Covered | `extract.email.security.test.ts` SEC-2; `hydrate-fields.test.ts` scrubPiiFromSummary suite |
| AC12 — fields[] hydrated from extracted_fields | Covered | `extract.email.bugfix.test.ts` INT-1; `hydrate-fields.test.ts` UNIT-3/4/5 |
| AC13 — legacy field keys continue to render | Covered | `i18n-parity.test.ts` AC13 regression suite (14 legacy keys) |

---

## BLOCKING findings

None.

---

## Non-blocking findings

| # | File:Line | Finding | Suggested fix |
|---|---|---|---|
| 1 | `src/server/ai/hydrate-fields.ts:87` | POLICY_RE false-positive risk. The pattern `\b[A-Z0-9]{4,}-?\d{1,4}\b` matches common free-text abbreviations: HTTP200, ERROR500, ISO8601, ZURICH2024, UUID1234 are all replaced with `[ref. omitida]`. The length >= 6 guard prevents 4-5-char matches only. In practice this rarely appears in claim summaries, but `ZURICH2024` (insurer name + year) and `HTTP200` (if a template error is echoed) are plausible. | Add a denylist of known-safe prefixes (HTTP, ISO, UUID, NULL, ERROR) to the POLICY_RE replacement callback, or narrow to require a preceding context signal (e.g. only replace when preceded by siniestro/poliza/ref keywords). |
| 2 | `tests/unit/server/worker/extract.email.bugfix.test.ts` | INT-3 scenario from the spec test matrix (mock AI returns severity=null on multi-vehicle Zurich-style email; final severity must be >= medium) is not a dedicated test. The coverage exists in `severity-classifier.test.ts:181` but the worker-level integration scenario is not asserted. | Add a focused INT-3 test that mocks extractEmailClaim returning severity: null on a Zurich-style body and asserts capturedCaseUpdates[0].severity === 'medium'. |
| 3 | `tests/unit/server/worker/extract.email.bugfix.test.ts` and `extract.email.security.test.ts` | Near-identical buildServiceMock() functions (~80 lines each) duplicated across both files. If a new table is added to the worker, one mock will silently diverge, causing false-passing tests. | Extract to a shared fixture file (e.g. `tests/fixtures/email-worker-mock.ts`) and import from both. |

---

## Nits

| # | File:Line | Finding |
|---|---|---|
| N1 | `src/server/worker/extract.ts:477-480` | The combined spread `{ ...scrubPiiFromSummary(extractedClaim), fields: hydrateFieldsFromExtracted(extractedClaim) }` is correct but subtle: hydrateFieldsFromExtracted is called on the pre-scrub claim (intentional — scrub does not touch .fields or .extracted_fields). A brief inline comment would prevent future readers from "optimising" this to pass the scrubbed result. |
| N2 | `src/server/ai/hydrate-fields.ts:79` | Comment says "7-8 contiguous digits" but the regex also matches dotted formats (12.345.678). Comment should mention dotted variant. |
| N3 | `src/server/ai/prompt.ts:263` | The field description for `dni` includes "do NOT echo verbatim; use only for matching hint" which slightly contradicts RULE D requiring extraction into structured fields. Clarify: "do NOT echo verbatim in summary/suggested_reply" (RULE D above already states the structured extraction requirement). |

---

## Security posture summary

- CORS: N/A (no new routes) · RLS: ✅ unchanged, all DB writes via service-role · Headers: ✅ unchanged · Cookie security: ✅ unchanged
- semgrep ERROR: 0 (tool not installed; manual review: no string interpolation in queries, no eval, no hardcoded secrets in diff)
- npm audit HIGH+: 0 (pre-existing: 2 moderate only)
- trivy HIGH+: N/A (no Dockerfile changes)
- License audit (AGPL/GPL/LGPL/SSPL): Clean — no new dependencies
- LLM controls:
  - LLM01 Prompt injection: PASS — XML sentinel delimiters unchanged; SEC-1 regression passes
  - LLM02 Insecure output handling: PASS — ExtractedClaimSchema.safeParse() gate unchanged; schema shape unchanged
  - LLM05 Improper output handling: PASS — scrubPiiFromSummary() defensive layer; SEC-2 regression passes
  - LLM06 Sensitive info disclosure: PASS — RULE D reworded correctly; structured logs contain no PII (SEC-2 verified)
  - LLM07 System prompt leakage: PASS — no secrets in system prompt
  - LLM08 Excessive agency: PASS — FSM containment unchanged; model cannot set case.status

---

## Operability

- /health: ✅ pre-existing, unchanged
- Structured logging without PII: ✅ confirmed (SEC-2 test verifies no PII in console.info calls)
- Deploy configs reference env vars only: ✅ no new deploy config changes
- Dangerous migrations: ✅ None (no schema changes in this PR)

---

## Artifacts

- README: ✅ · .env.example: ✅ (no new vars required) · .env NOT committed: ✅ · Lockfile (pnpm-lock.yaml): ✅ · CI (ci.yml): ✅ Node 22 satisfies engines.node >=22
- SBOM workflow: non-blocking warn (pre-existing gap, sbom.yml absent)
- CodeQL: ✅ codeql.yml exists

---

## Detailed notes per review focus area

**RULE D rewrite:** The new wording at `prompt.ts:217-226` correctly resolves the ambiguity that caused BUG 1. The old "NEVER echo back" language was interpreted by the model as "never include in any field." The new language explicitly requires extraction into `extracted_fields` AND `fields[]`, labels these as protected by RLS/tenant scoping, and separately forbids echoing in free-text fields. The justification text ("failing to extract them is a defect, not a security feature") is pedagogically effective for a model that over-applies PII caution.

**RULE F field-mirror:** Unambiguous. The four required properties (field_key, field_value, confidence, source) are listed explicitly. The "persistence source of truth" framing aligns with the worker's actual behavior. The source="memory" branch for memory-hint values is handled correctly.

**hydrateFieldsFromExtracted() edge cases:** All critical cases are covered by tests: undefined extracted_fields early return, empty/whitespace value skip, 2000-char truncation, confidence clamping [0,1], no mutation of input array, no duplicate insertion. One subtle correctness point: values with confidence=0 in field_confidences ARE hydrated (if the value string is non-empty), and then excluded by the 0.60 threshold filter in the worker. This is correct — the hydration function's job is to populate fields[], not to filter; filtering is the worker's job.

**scrubPiiFromSummary() ordering:** The five-step scrub sequence is correct: (1) full_name literal, (2) extracted DNI literal, (3) extracted policy_number literal, (4) generic DNI pattern fallback, (5) generic policy/ref pattern fallback. Steps 1-3 use the known extracted values; steps 4-5 are catch-all. The potential for step 5 (POLICY_RE) to produce false positives on abbreviations like HTTP200 is noted as Non-blocking #1.

**Worker insertion point:** Hydration at extract.ts:477-480 is definitively before the HIGH_CONFIDENCE_THRESHOLD filter at extract.ts:534. Hydrated entries default to 0.85 >> 0.60, so they will persist to DB. AC12 requirement satisfied.

**i18n keys:** The 8 new field.* keys are additive and do not conflict with existing keys. field.email vs case.detail.email are distinct namespaces. All 14 legacy keys verified present. TypeScript compiles clean (enUS: Record<TranslationKey,string> enforces key parity at compile time).

**Test isolation:** All integration-style tests correctly use vi.hoisted() + vi.mock() before module import. No real network calls. MOCK_AI env var explicitly deleted to force real extractor path (mocked via vi.mock). Tests are isolated per beforeEach with vi.clearAllMocks(). 1359 unit tests pass.
