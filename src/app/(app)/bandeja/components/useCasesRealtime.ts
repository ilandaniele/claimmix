/**
 * useCasesRealtime — polling hook for the cases dashboard.
 *
 * Replaces the former realtime database subscription with
 * plain polling against the existing GET /api/cases endpoint:
 *   - Every ~5 seconds: fetch the current filter view (per_page=100, newest first).
 *   - New ids vs. the previous snapshot  → onInsert(row)  (toast "Nuevo siniestro...")
 *   - Changed rows vs. the snapshot     → onUpdate(row, prevStatus)
 *   - The first successful poll only seeds the snapshot (no handler calls),
 *     mirroring realtime semantics where only *changes* emitted events.
 *
 * Hidden tabs are skipped (document.visibilityState), overlapping requests are
 * prevented with an in-flight guard, and the interval is cleared on unmount.
 *
 * The exported name/interface is unchanged so consumers don't change.
 *
 * Pure utility functions (mergeCaseUpdate, computeStatusCounts, formatCaseNumber)
 * are in casesRealtimeUtils.ts for testability.
 */

"use client";

import { useEffect, useRef } from "react";
import type { CaseRow } from "@/server/cases/list";
import type { CaseStatus } from "@/lib/schemas/cases";

interface RealtimeHandlers {
  onInsert: (newCase: CaseRow) => void;
  onUpdate: (updatedCase: CaseRow, prevStatus: CaseStatus | null) => void;
}

const POLL_INTERVAL_MS = 5000;

/** URL filters forwarded to /api/cases (the ones the dashboard supports). */
const FILTER_PARAMS = ["status", "type", "channel", "severity", "is_claim"] as const;

/** Build the /api/cases query string from the current location filters. */
function buildQuery(): string {
  const current = new URLSearchParams(window.location.search);
  const params = new URLSearchParams();
  for (const key of FILTER_PARAMS) {
    const value = current.get(key);
    if (value) params.set(key, value);
  }
  params.set("page", "1");
  params.set("per_page", "100");
  params.set("sort", "created_at");
  params.set("order", "desc");
  return params.toString();
}

/** Shallow change detection on the serialized row (rows are small/flat). */
function rowChanged(prev: CaseRow, next: CaseRow): boolean {
  return JSON.stringify(prev) !== JSON.stringify(next);
}

/**
 * Poll for case changes. Emits insert/update events by diffing successive
 * snapshots of the cases list (no DELETE per FSM — cases are never deleted).
 */
export function useCasesRealtime(handlers: RealtimeHandlers) {
  // Keep handlers in a ref so the polling closure stays stable across renders.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let snapshot: Map<string, CaseRow> | null = null;

    async function poll() {
      // Skip hidden tabs and overlapping requests.
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const res = await fetch(`/api/cases?${buildQuery()}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;

        const body = (await res.json()) as { data?: CaseRow[] };
        const rows = Array.isArray(body?.data) ? body.data : [];
        if (cancelled) return;

        if (snapshot === null) {
          // First poll: seed the baseline silently.
          snapshot = new Map(rows.map((row) => [row.id, row]));
          return;
        }

        const next = new Map(snapshot);
        for (const row of rows) {
          const prev = next.get(row.id);
          if (!prev) {
            handlersRef.current.onInsert(row);
          } else if (rowChanged(prev, row)) {
            handlersRef.current.onUpdate(
              row,
              (prev.status as CaseStatus | null) ?? null
            );
          }
          next.set(row.id, row);
        }
        snapshot = next;
      } catch {
        // Transient network/parse errors: ignore, retry on the next tick.
      } finally {
        inFlight = false;
      }
    }

    void poll(); // Seed the baseline immediately on mount.
    const intervalId = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []); // Empty deps — polling is set up once and uses refs for handlers.
}

// Re-export pure utils from casesRealtimeUtils.ts for backward compatibility.
export {
  formatCaseNumber,
  mergeCaseUpdate,
  computeStatusCounts,
} from "./casesRealtimeUtils";
