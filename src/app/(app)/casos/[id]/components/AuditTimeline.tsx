"use client";

import { formatDate } from "@/lib/utils";
import { useT, useLocale } from "@/lib/i18n/LocaleContext";
import { esAR, type TranslationKey } from "@/lib/i18n";
import { claveDeMotivoDeRechazo } from "../_components/AttachmentsPanel";

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
  channel?: string;
}

function eventLabel(
  eventType: string,
  channel: string | undefined,
  t: (key: TranslationKey) => string
): string {
  // El correo por WhatsApp lo llevan las mismas tablas que el correo real, así
  // que el evento es igual — «email.received» — pero para quien lee la
  // pantalla es un mensaje de WhatsApp, no un mail.
  if (eventType === "email.received" && channel?.startsWith("whatsapp")) {
    return t("audit.whatsapp.received");
  }

  const i18nKey = `audit.${eventType}` as TranslationKey;
  if (i18nKey in esAR) {
    return t(i18nKey);
  }
  return eventType
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" → ");
}

/** Motivos propios que esta pantalla sabe nombrar, además de los de adjuntos. */
const MOTIVOS_DEL_CASO: Record<string, TranslationKey> = {
  processing_timeout: "case.detail.motivo.processingTimeout",
  conflict: "case.detail.motivo.conflict",
  lesiones: "case.detail.motivo.lesiones",
};

const SEVERIDAD = /^severidad (high|critical)$/;

function motivoLegible(
  reason: string,
  t: (key: TranslationKey) => string
): string {
  const clave = claveDeMotivoDeRechazo(reason);
  if (clave) return t(clave);

  const propio = MOTIVOS_DEL_CASO[reason];
  if (propio) return t(propio);

  // No se toca `orchestrate.ts:294`: ese texto también va a `alertSpecialists`.
  const m = SEVERIDAD.exec(reason);
  if (m) return t("case.detail.motivo.severidad").replace("{nivel}", t(`severity.${m[1]}` as TranslationKey));

  return reason;
}

function dotColor(eventType: string): string {
  if (eventType.startsWith("case.closed")) return "bg-slate-400";
  if (eventType.startsWith("case.")) return "bg-blue-400";
  if (eventType.startsWith("ai.")) return "bg-violet-400";
  if (eventType.startsWith("auth.")) return "bg-green-400";
  return "bg-slate-300";
}

export function AuditTimeline({ events, channel }: AuditTimelineProps) {
  const t = useT();
  const { locale } = useLocale();

  if (events.length === 0) {
    return (
      <p className="text-sm text-slate-500" role="status">
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
              {eventLabel(event.event_type, channel, t)}
            </p>
            <time
              dateTime={event.created_at}
              className="text-xs text-slate-500"
            >
              {formatDate(event.created_at, locale)}
            </time>
            {/*
              * El motivo, traducido cuando es un código de rechazo de adjunto.
              *
              * Acá se leía «Adjunto rechazado — Motivo: size_exceeded»: el
              * mismo código interno que el panel de adjuntos ya no muestra, en
              * la misma pantalla y para la misma persona. Un motivo que no sea
              * uno de esos códigos sale como está: el historial también guarda
              * prosa fija del código —«sin respuesta del denunciante»— y
              * códigos de otras partes —«conflict», «unsafe_run»—.
              */}
            {event.reason != null && (
              <p className="text-xs text-slate-500 mt-0.5">
                {t("case.detail.auditReason")}:{" "}
                <span className="font-medium">{motivoLegible(event.reason, t)}</span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
