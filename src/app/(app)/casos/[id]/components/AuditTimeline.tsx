"use client";

import { formatDate } from "@/lib/utils";
import { useT } from "@/lib/i18n/LocaleContext";
import { esAR, type TranslationKey } from "@/lib/i18n";

/*
 * Sólo lo que esta línea de tiempo pinta.
 *
 * Antes declaraba la fila entera de `audit_log` —con `ip`, `ua`, `actor_id` y
 * el payload completo— y el servidor se la mandaba entera al navegador. La
 * pantalla muestra el tipo, la fecha y, si lo hay, el motivo.
 *
 * Que el tipo pida menos es lo que hace que el servidor pueda mandar menos: si
 * acá siguiera pidiendo `ip`, la consulta tendría que seguir trayéndola.
 */
interface AuditLogEntry {
  id: number;
  event_type: string;
  created_at: string;
  reason: string | null;
}

interface AuditTimelineProps {
  events: AuditLogEntry[];
}

function eventLabel(
  eventType: string,
  t: (key: TranslationKey) => string
): string {
  const i18nKey = `audit.${eventType}` as TranslationKey;
  if (i18nKey in esAR) {
    return t(i18nKey);
  }
  return eventType
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" → ");
}

function dotColor(eventType: string): string {
  if (eventType.startsWith("case.closed")) return "bg-slate-400";
  if (eventType.startsWith("case.")) return "bg-blue-400";
  if (eventType.startsWith("ai.")) return "bg-violet-400";
  if (eventType.startsWith("auth.")) return "bg-green-400";
  return "bg-slate-300";
}

export function AuditTimeline({ events }: AuditTimelineProps) {
  const t = useT();

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
          <span
            aria-hidden="true"
            className={`absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-white ${dotColor(event.event_type)}`}
          />
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-slate-700 leading-tight">
              {eventLabel(event.event_type, t)}
            </p>
            <time
              dateTime={event.created_at}
              className="text-xs text-slate-400"
            >
              {formatDate(event.created_at)}
            </time>
            {event.reason != null && (
              <p className="text-xs text-slate-500 mt-0.5">
                {t("case.detail.auditReason")}:{" "}
                <span className="font-medium">{event.reason}</span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
