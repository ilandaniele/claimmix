/**
 * AuditTimeline — renders the last 20 audit log events as a vertical timeline.
 *
 * AC14: Timeline of last 20 events with timestamp + action in Spanish.
 * Events are pre-sorted descending by created_at (from getCaseDetail).
 */

import { formatDate } from "@/lib/utils";
import { t, esAR, type TranslationKey } from "@/lib/i18n";
import type { Database } from "@/lib/supabase/types";

type AuditLogRow = Database["public"]["Tables"]["audit_log"]["Row"];

interface AuditTimelineProps {
  events: AuditLogRow[];
}

/**
 * Map audit event_type → Spanish label.
 * Falls back to the raw event_type if not mapped.
 */
function eventLabel(eventType: string): string {
  const i18nKey = `audit.${eventType}` as TranslationKey;
  if (i18nKey in esAR) {
    return t(i18nKey);
  }
  // Fallback — strip dot notation and capitalize
  return eventType
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" → ");
}

/** Pick a dot color based on event type category */
function dotColor(eventType: string): string {
  if (eventType.startsWith("case.closed")) return "bg-slate-400";
  if (eventType.startsWith("case.")) return "bg-blue-400";
  if (eventType.startsWith("ai.")) return "bg-violet-400";
  if (eventType.startsWith("auth.")) return "bg-green-400";
  return "bg-slate-300";
}

export function AuditTimeline({ events }: AuditTimelineProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-slate-400" role="status">
        {t("case.detail.noAuditEvents")}
      </p>
    );
  }

  return (
    <ol
      className="relative border-l border-slate-200 ml-2 space-y-4"
      aria-label="Historial de eventos"
    >
      {events.map((event) => (
        <li key={event.id} className="ml-4">
          {/* Timeline dot */}
          <span
            aria-hidden="true"
            className={`absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-white ${dotColor(event.event_type)}`}
          />
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-slate-700 leading-tight">
              {eventLabel(event.event_type)}
            </p>
            <time
              dateTime={event.created_at}
              className="text-xs text-slate-400"
            >
              {formatDate(event.created_at)}
            </time>
            {/* Show reason from payload if present */}
            {event.payload?.reason != null && (
              <p className="text-xs text-slate-500 mt-0.5">
                Motivo:{" "}
                <span className="font-medium">
                  {String(event.payload.reason as string | number | boolean)}
                </span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
