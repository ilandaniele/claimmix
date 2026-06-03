/**
 * GmailStatusSection — admin-only Gmail poll-state panel for /configuracion.
 *
 * AC3: Connected → green pill "Conectado" + relative last_polled_at.
 * AC4: Error     → red pill "Error" + last_error message (truncated to 100 chars).
 * AC5: Not configured → gray pill "Sin configurar".
 * AC6: Returns null silently on HTTP 403 (non-admin user).
 *
 * Fetches GET /api/admin/gmail-status on mount.
 * Only renders if the request returns HTTP 200.
 */

"use client";

import { useState, useEffect } from "react";
import { t } from "@/lib/i18n";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GmailStatus {
  email_address: string | null;
  last_polled_at: string | null;
  is_connected: boolean;
  last_error: string | null;
}

type LoadState = "loading" | "ready" | "hidden";

// ── Relative time formatter ────────────────────────────────────────────────────

const LOCALE = "es-AR";
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

function formatRelative(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "—";
  const date = new Date(isoTimestamp);
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHours = Math.round(diffMin / 60);
  const diffDays = Math.round(diffHours / 24);

  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  if (Math.abs(diffHours) < 24) return rtf.format(diffHours, "hour");
  return rtf.format(diffDays, "day");
}

// ── Pill component ────────────────────────────────────────────────────────────

interface PillProps {
  variant: "connected" | "error" | "not_configured";
  label: string;
}

function StatusPill({ variant, label }: PillProps) {
  const styles: Record<string, string> = {
    connected: "bg-green-100 text-green-700",
    error: "bg-red-100 text-red-700",
    not_configured: "bg-slate-100 text-slate-600",
  };
  return (
    <span
      role="status"
      aria-label={`Gmail: ${label}`}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[variant]}`}
    >
      {label}
    </span>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="flex items-center gap-3" aria-busy="true" aria-label="Cargando estado de Gmail">
      <div className="h-5 w-20 animate-pulse rounded-full bg-slate-200" />
      <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function GmailStatusSection() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [status, setStatus] = useState<GmailStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchStatus() {
      try {
        const res = await fetch("/api/admin/gmail-status");

        if (!res.ok) {
          // 403 = not admin — hide the section silently (AC6).
          // Any other non-200 — also hide; do not show error UI.
          if (!cancelled) setLoadState("hidden");
          return;
        }

        const data: GmailStatus = await res.json();
        if (!cancelled) {
          setStatus(data);
          setLoadState("ready");
        }
      } catch {
        // Network failure — hide the section rather than show an error.
        if (!cancelled) setLoadState("hidden");
      }
    }

    fetchStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  // Hidden (403 or fetch error) — render nothing.
  if (loadState === "hidden") return null;

  // Loading skeleton.
  if (loadState === "loading") {
    return (
      <div className="px-5 py-4">
        <Skeleton />
      </div>
    );
  }

  // Render status based on data shape.
  const s = status!;

  let pillVariant: PillProps["variant"];
  let pillLabel: string;

  if (s.is_connected) {
    pillVariant = "connected";
    pillLabel = t("gmail.status.connected");
  } else if (s.last_error) {
    pillVariant = "error";
    pillLabel = t("gmail.status.error");
  } else {
    pillVariant = "not_configured";
    pillLabel = t("gmail.status.not_configured");
  }

  return (
    <div className="divide-y divide-slate-50">
      {/* Status pill row */}
      <div className="flex items-center gap-4 py-1.5">
        <span className="w-44 flex-none text-xs text-slate-500">
          Estado
        </span>
        <div className="text-sm text-slate-800">
          <StatusPill variant={pillVariant} label={pillLabel} />
        </div>
      </div>

      {/* Masked account email row */}
      {s.email_address && (
        <div className="flex items-center gap-4 py-1.5">
          <span className="w-44 flex-none text-xs text-slate-500">
            {t("gmail.status.account")}
          </span>
          <div className="text-sm font-mono text-slate-700">
            {s.email_address}
          </div>
        </div>
      )}

      {/* Last sync row — only shown when we have a timestamp */}
      {s.last_polled_at && (
        <div className="flex items-center gap-4 py-1.5">
          <span className="w-44 flex-none text-xs text-slate-500">
            {t("gmail.status.last_sync")}
          </span>
          <div
            className="text-sm text-slate-700"
            title={new Date(s.last_polled_at).toLocaleString(LOCALE)}
          >
            {formatRelative(s.last_polled_at)}
          </div>
        </div>
      )}

      {/* Error message row — shown when last_error is set (AC4) */}
      {s.last_error && (
        <div className="py-1.5">
          <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            {/* Truncate to 100 chars to limit potential PII exposure in error strings */}
            {s.last_error.length > 100
              ? `${s.last_error.slice(0, 100)}…`
              : s.last_error}
          </div>
        </div>
      )}
    </div>
  );
}
