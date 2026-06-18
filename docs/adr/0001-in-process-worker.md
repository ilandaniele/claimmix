# ADR 0001 — In-process AI extraction worker (not a queue)

**Date:** 2026-06-02
**Status:** Accepted
**Deciders:** Senior Dev (ClaimMix crew)

## Context

AI extraction (OpenAI gpt-4o-mini) takes 5–20 seconds. Blocking the intake HTTP request would
cause 504 gateway timeouts and poor UX. A background queue (Inngest, Trigger.dev, BullMQ)
would be the production-grade solution but adds operational complexity.

## Decision

For MVP: use Next.js Route Handler with `waitUntil()` from the Vercel runtime to run the
extraction worker in-process asynchronously. The intake endpoint returns 202 immediately;
the case appears in the dashboard when polling picks up the finished worker state.

```typescript
// src/app/api/intake/simulate/route.ts
import { after } from "next/server";
after(async () => { await runExtractionWorker(caseId); });
return NextResponse.json({ case_id, status: "procesando" }, { status: 202 });
```

## Consequences

**Good:**
- No external service dependency for MVP
- Zero additional cost (runs in the same serverless function)
- Simpler deployment (no worker process to manage)

**Bad:**
- Vercel Hobby function timeout: 10 seconds. Extraction must finish within this window.
  Mitigation: gpt-4o-mini p95 latency is ~3–8 seconds; `waitUntil` extends beyond the
  response deadline but NOT beyond the platform timeout. If extraction exceeds 10s, the
  worker is killed and the case stays in `procesando` until a retry or re-analyze.
- Not horizontally scalable: heavy load → concurrent workers → function memory pressure.
  Mitigation: semaphore in code (10 concurrent workers per tenant).

## Upgrade path (phase 2)

Replace `after()` with an Inngest event (`inngest.send("case/intake.simulate", { caseId })`)
and move `runExtractionWorker` to an Inngest function. No API contract changes required.
