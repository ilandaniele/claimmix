/**
 * useCasesRealtime — Supabase Realtime hook for the cases dashboard.
 *
 * AC12: Subscribes to postgres_changes on the cases table.
 *   - INSERT: new case appears at top of table, triggers toast "Nuevo siniestro recibido: SIN-..."
 *   - UPDATE: status change updates the row in-place, triggers toast "Siniestro SIN-... actualizado: X → Y"
 *
 * The hook merges realtime updates with the initial server-fetched data.
 * Count badges update in real-time as rows come in.
 *
 * Pure utility functions (mergeCaseUpdate, computeStatusCounts, formatCaseNumber)
 * are in casesRealtimeUtils.ts for testability without Supabase browser client.
 */

"use client";

import { useEffect, useRef } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import type { CaseRow } from "@/server/cases/list";
import type { CaseStatus } from "@/lib/schemas/cases";

interface RealtimeHandlers {
  onInsert: (newCase: CaseRow) => void;
  onUpdate: (updatedCase: CaseRow, prevStatus: CaseStatus | null) => void;
}

/**
 * Subscribe to realtime case changes for a given tenant.
 * The subscription is scoped to INSERT and UPDATE events only (no DELETE per FSM — cases are never deleted).
 */
export function useCasesRealtime(handlers: RealtimeHandlers) {
  // Keep handlers in a ref so the subscription closure stays stable across renders.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const channel = supabaseBrowser
      .channel("cases-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "cases",
        },
        (payload) => {
          const newCase = payload.new as CaseRow;
          handlersRef.current.onInsert(newCase);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "cases",
        },
        (payload) => {
          const updatedCase = payload.new as CaseRow;
          const prevStatus = (payload.old as Partial<CaseRow>)?.status as CaseStatus | null ?? null;
          handlersRef.current.onUpdate(updatedCase, prevStatus);
        }
      )
      .subscribe();

    return () => {
      supabaseBrowser.removeChannel(channel);
    };
  }, []); // Empty deps — subscription is set up once and uses ref for handlers.
}

// Re-export pure utils from casesRealtimeUtils.ts for backward compatibility.
export {
  formatCaseNumber,
  mergeCaseUpdate,
  computeStatusCounts,
} from "./casesRealtimeUtils";
