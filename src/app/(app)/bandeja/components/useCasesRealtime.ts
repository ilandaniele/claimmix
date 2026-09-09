/**
 * useCasesRealtime — polling hook for the cases dashboard.
 *
 * Replaces the former realtime database subscription with
 * plain polling against the existing GET /api/cases endpoint:
 *   - Cada cinco segundos si hay movimiento, hasta cada treinta si no lo hay:
 *     fetch the current filter view (per_page=100, newest first).
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
import { PARAMS_DE_FILTRO } from "./grupos-de-filtro";

interface RealtimeHandlers {
  onInsert: (newCase: CaseRow) => void;
  onUpdate: (updatedCase: CaseRow, prevStatus: CaseStatus | null) => void;
}

/*
 * Cada cinco segundos, para siempre, en cada pestaña abierta: eso costaba tres
 * viajes a la base por vuelta —uno de ellos una ESCRITURA, el contador del
 * limitador— y se comía doce de los cien pedidos por minuto del cupo sin que
 * nadie hiciera nada. La bandeja competía consigo misma por la base.
 *
 * Cinco segundos importan cuando algo está pasando. Cuando no pasa nada, la
 * espera se duplica hasta medio minuto, y vuelve a cinco en cuanto aparece un
 * cambio o la persona vuelve a la pestaña. Una bandeja quieta cuesta seis veces
 * menos; una con movimiento responde igual que antes.
 */
const POLL_MIN_MS = 5000;
const POLL_MAX_MS = 30000;

/**
 * Los filtros que el sondeo reenvía a /api/cases.
 *
 * Se arma desde `PARAMS_DE_FILTRO` en vez de repetir la lista, que es lo que
 * estaba: había TRES listas de parámetros —ésta, la de `page.tsx` y la del
 * esquema— y las tres podían separarse sin que nada fallara. El síntoma de que
 * se separen no es un error: es que cada cinco a treinta segundos el sondeo
 * trae filas que no cumplen el filtro nuevo y las inyecta en la lista, así que
 * la pantalla se contradice sola y hay que estar mirándola para verlo.
 *
 * `status` va aparte porque no vive en el panel: son las pestañas.
 */
export const FILTER_PARAMS = ["status", ...PARAMS_DE_FILTRO] as const;

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
    let demora = POLL_MIN_MS;
    let timerId = 0;

    async function poll(): Promise<boolean> {
      // Skip hidden tabs and overlapping requests.
      if (inFlight || document.visibilityState === "hidden") return false;
      inFlight = true;
      try {
        const res = await fetch(`/api/cases?${buildQuery()}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok || cancelled) return false;

        const body = (await res.json()) as { data?: CaseRow[] };
        const rows = Array.isArray(body?.data) ? body.data : [];
        if (cancelled) return false;

        if (snapshot === null) {
          // First poll: seed the baseline silently.
          snapshot = new Map(rows.map((row) => [row.id, row]));
          return false;
        }

        let hubo = false;
        const next = new Map(snapshot);
        for (const row of rows) {
          const prev = next.get(row.id);
          if (!prev) {
            hubo = true;
            handlersRef.current.onInsert(row);
          } else if (rowChanged(prev, row)) {
            hubo = true;
            handlersRef.current.onUpdate(
              row,
              (prev.status as CaseStatus | null) ?? null
            );
          }
          next.set(row.id, row);
        }
        snapshot = next;
        return hubo;
      } catch {
        // Transient network/parse errors: ignore, retry on the next tick.
        return false;
      } finally {
        inFlight = false;
      }
    }

    // Una cadena de timeouts y no un interval: la espera cambia sola.
    function programar(ms: number) {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        void poll().then((hubo) => {
          if (cancelled) return;
          demora = hubo ? POLL_MIN_MS : Math.min(demora * 2, POLL_MAX_MS);
          programar(demora);
        });
      }, ms);
    }

    // Volver a la pestaña es la señal de que alguien está mirando: se vuelve a
    // la espera corta y se pide de nuevo en el acto.
    function alVolver() {
      if (cancelled || document.visibilityState !== "visible") return;
      demora = POLL_MIN_MS;
      programar(0);
    }

    void poll(); // Seed the baseline immediately on mount.
    programar(demora);
    document.addEventListener("visibilitychange", alVolver);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, []); // Empty deps — polling is set up once and uses refs for handlers.
}

// Re-export pure utils from casesRealtimeUtils.ts for backward compatibility.
export {
  formatCaseNumber,
  mergeCaseUpdate,
  computeStatusCounts,
} from "./casesRealtimeUtils";
