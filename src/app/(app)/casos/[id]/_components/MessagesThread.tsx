/**
 * MessagesThread — Client Component for the case conversation panel: lo que
 * escribió la persona y lo que le contestó el agente, por mail o por WhatsApp.
 *
 * AC11: Renders one card per message, oldest first, with who wrote it,
 *       from_addr, subject (email only), body_text preview, and relative
 *       received_at. Outbound cards sit on the right with another background.
 * AC12: Returns null (renders nothing) when messages array is empty.
 * AC13: body_text preview truncated to 300 chars in collapsed state.
 * AC14: Shows attachment count badge (paperclip icon + count) when > 0.
 *
 * PII protection: from_addr, subject, body_text are PII.
 * They are rendered in the UI but NEVER logged to console.
 *
 * Fetches GET /api/cases/[caseId]/messages on mount.
 * Uses collapsible cards (click to expand full body_text up to 2000 chars from API).
 */

"use client";

import { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";
import type { MensajeDeLaConversacion as Message } from "@/server/cases/conversacion";
import type { EstadoDeRespuesta } from "@/core/whatsapp/puede-responder";
import { BloqueoPlanPro } from "@/app/(app)/_components/BloqueoPlanPro";

/** Lo que contesta `GET /api/cases/:id/messages`. */
interface RespuestaDeMensajes {
  messages: Message[];
  recortada: boolean;
  respuesta: EstadoDeRespuesta;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

// ── Constants ─────────────────────────────────────────────────────────────────

const PREVIEW_MAX_CHARS = 300;
const SUBJECT_MAX_CHARS = 60;
const LOCALE = "es-AR";

/*
 * Lo saliente que no llegó, o no se sabe si llegó, lo dice. 'queued' es un
 * mail que no terminó de salir: el envío se cortó o no se pudo anotar cómo
 * terminó.
 */
const ESTADOS: Record<string, { clave: TranslationKey; clase: string }> = {
  failed: { clave: "messages.thread.no_enviado", clase: "bg-red-50 text-red-700" },
  queued: { clave: "messages.thread.sin_confirmar", clase: "bg-amber-50 text-amber-800" },
  skipped_simulated: { clave: "messages.thread.simulado", clase: "bg-amber-50 text-amber-800" },
};

// ── Relative time formatter ────────────────────────────────────────────────────

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

function formatRelative(isoTimestamp: string): string {
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

// ── Avatar helper ─────────────────────────────────────────────────────────────

function getAvatarLetter(fromAddr: string | null): string {
  const letra = fromAddr?.charAt(0).toUpperCase() ?? "";
  // «[oculto]», lo que ve un viewer, no tiene inicial.
  return /[\p{L}\p{N}]/u.test(letra) ? letra : "?";
}

// ── Paperclip icon ────────────────────────────────────────────────────────────

function PaperclipIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-3.5 h-3.5"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function MessageSkeleton() {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white px-4 py-4 animate-pulse"
      aria-busy="true"
      aria-label="Cargando mensajes"
    >
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-full bg-slate-200 flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-32 rounded bg-slate-200" />
          <div className="h-3 w-48 rounded bg-slate-100" />
          <div className="h-3 w-full rounded bg-slate-100" />
          <div className="h-3 w-4/5 rounded bg-slate-100" />
        </div>
      </div>
    </div>
  );
}

// ── Message card ──────────────────────────────────────────────────────────────

interface MessageCardProps {
  message: Message;
}

function MessageCard({ message }: MessageCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const saliente = message.direction === "outbound";
  const autor = t(saliente ? "messages.thread.agente" : "messages.thread.denunciante");
  // Lo saliente lleva la inicial del agente: el remitente es el buzón de la
  // aseguradora o no hay ninguno.
  const avatarLetter = saliente ? autor.charAt(0) : getAvatarLetter(message.from_addr);
  // WhatsApp no tiene asunto; el alta guarda "WhatsApp" ahí y no dice nada. La
  // vista previa del mail simulado tampoco lo guarda.
  const conAsunto = message.provider !== "whatsapp" && !(saliente && !message.subject);
  const estado = message.estado_envio ? ESTADOS[message.estado_envio] : undefined;

  // Truncate subject to SUBJECT_MAX_CHARS for display in collapsed header.
  const subjectDisplay =
    message.subject
      ? message.subject.length > SUBJECT_MAX_CHARS
        ? `${message.subject.slice(0, SUBJECT_MAX_CHARS)}…`
        : message.subject
      : t("messages.thread.no_subject");

  // Body preview: collapsed = first 300 chars; expanded = full body_text (≤2000 from API).
  const bodyText = message.body_text ?? "";
  const isLong = bodyText.length > PREVIEW_MAX_CHARS;
  const previewText = isLong && !expanded
    ? `${bodyText.slice(0, PREVIEW_MAX_CHARS)}…`
    : bodyText;

  // Sólo clases con par oscuro en globals.css, y sin bg-blue-50 de fondo: el
  // slate-500 de la hora no llega a 4,5:1 sobre ese azul.
  return (
    <article
      data-testid="message-card"
      data-direction={message.direction}
      className={
        saliente
          ? "ml-8 rounded-lg border border-blue-200 bg-slate-50"
          : "mr-8 rounded-lg border border-slate-200 bg-white"
      }
    >
      {/* Card header — always visible */}
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          {/* Avatar circle */}
          <div
            className="flex-shrink-0 h-8 w-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-semibold select-none"
            aria-hidden="true"
          >
            {avatarLetter}
          </div>

          <div className="flex-1 min-w-0">
            {/* From address + relative time row */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={
                    saliente
                      ? "flex-shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700"
                      : "flex-shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                  }
                >
                  {autor}
                </span>
                {message.from_addr && (
                  <span className="text-sm font-medium text-slate-800 truncate">
                    {message.from_addr}
                  </span>
                )}
                {estado && (
                  <span
                    className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${estado.clase}`}
                  >
                    {t(estado.clave)}
                  </span>
                )}
              </div>
              {/*
                slate-500, no 400: esto es TEXTO, no un icono.

                Se salvó del barrido de contraste porque lleva `flex-shrink-0`,
                que era uno de los marcadores con los que se reconocía a los
                iconos. Pero es la hora de cada mensaje del hilo, y 400 sobre
                blanco da 2,56:1 contra el 4,5:1 que pide WCAG 1.4.3 para texto
                normal.
              */}
              <time
                dateTime={message.received_at}
                className="text-xs text-slate-500 flex-shrink-0"
                title={new Date(message.received_at).toLocaleString(LOCALE)}
              >
                {formatRelative(message.received_at)}
              </time>
            </div>

            {/* Subject */}
            {conAsunto && (
              <div className="mt-0.5 text-sm font-semibold text-slate-900 truncate">
                {subjectDisplay}
              </div>
            )}

            {/* Attachment badge — AC14 */}
            {message.attachment_count > 0 && (
              <div className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500">
                <PaperclipIcon />
                <span
                  className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600"
                  aria-label={`${message.attachment_count} ${t("messages.thread.attachments")}`}
                >
                  {message.attachment_count}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Body preview — AC13 */}
        {bodyText && (
          <div className="mt-2 ml-11">
            <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">
              {previewText}
            </p>
            {isLong && (
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="mt-1 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                aria-expanded={expanded}
              >
                {expanded ? t("messages.thread.collapse") : t("messages.thread.expand")}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface MessagesThreadProps {
  caseId: string;
}

/**
 * El marco de la conversacion: borde, titulo y adentro lo que haya.
 *
 * A nivel de modulo y no adentro de MessagesThread: un componente declarado
 * durante el render se vuelve a crear en cada pasada, y React lo trata como
 * otro componente — le reinicia el estado a todo lo que tenga adentro. Acá hoy
 * no habria roto nada porque las tarjetas no guardan estado, pero es la clase
 * de bug que aparece el dia que alguien agrega un desplegable.
 */
function Marco({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <section
      aria-labelledby="messages-thread-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2
        id="messages-thread-heading"
        className="text-sm font-semibold text-slate-900 mb-4"
      >
        {t("messages.thread.title")}
      </h2>
      {children}
    </section>
  );
}

export function MessagesThread({ caseId }: MessagesThreadProps) {
  const t = useT();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [messages, setMessages] = useState<Message[]>([]);
  const [recortada, setRecortada] = useState(false);
  const [respuesta, setRespuesta] = useState<EstadoDeRespuesta | null>(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [envioEstado, setEnvioEstado] = useState<"enviado" | "fallo" | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchMessages() {
      try {
        const res = await fetch(`/api/cases/${caseId}/messages`);

        if (!res.ok) {
          if (!cancelled) setLoadState("error");
          return;
        }

        const data: RespuestaDeMensajes = await res.json();
        if (!cancelled) {
          setMessages(data.messages);
          setRecortada(data.recortada);
          setRespuesta(data.respuesta);
          setLoadState("ready");
        }
      } catch {
        // Network failure — show error state.
        if (!cancelled) setLoadState("error");
      }
    }

    fetchMessages();

    return () => {
      cancelled = true;
    };
  }, [caseId]);

  async function enviarRespuesta() {
    if (!texto.trim() || enviando) return;
    setEnviando(true);
    setEnvioEstado(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/responder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto }),
      });
      if (res.ok) {
        setTexto("");
        setEnvioEstado("enviado");
      } else {
        setEnvioEstado("fallo");
      }
    } catch {
      setEnvioEstado("fallo");
    } finally {
      setEnviando(false);
    }
  }

  /*
   * La tarjeta entera, titulo incluido, vive aca adentro.
   *
   * Estaba en page.tsx, envolviendo a este componente: el encabezado
   * «Mensajes recibidos» se pintaba para TODO caso de mail, y este componente
   * devolvia null cuando no habia ninguno. Resultado: una tarjeta con titulo y
   * nada abajo en cualquier siniestro recien entrado — que es el estado mas
   * frecuente de todos y el que mas se mira.
   *
   * Quien sabe si hay algo que mostrar es este componente, asi que el marco es
   * suyo. Asi «no hay mensajes» hace desaparecer la tarjeta entera y no queda
   * un titulo huerfano.
   */

  // Loading: show skeleton cards.
  if (loadState === "loading") {
    return (
      <Marco>
        <div className="space-y-3">
          <MessageSkeleton />
          <MessageSkeleton />
        </div>
      </Marco>
    );
  }

  // Error: show generic error message (no PII).
  if (loadState === "error") {
    return (
      <Marco>
        <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {t("error.generic")}
        </div>
      </Marco>
    );
  }

  // AC12: return null when messages array is empty — no element with data-testid="messages-thread".
  if (messages.length === 0) {
    return null;
  }

  return (
    <Marco>
      <div data-testid="messages-thread">
        {recortada && (
          <p className="mb-3 text-xs text-slate-500">{t("messages.thread.recortada")}</p>
        )}
        <div className="space-y-3">
          {messages.map((message) => (
            <MessageCard key={message.id} message={message} />
          ))}
        </div>
        {respuesta && respuesta.motivo !== "rol" && (
          <div className="mt-4 border-t border-slate-200 pt-4">
            {respuesta.motivo === "plan" ? (
              <BloqueoPlanPro t={t} />
            ) : respuesta.habilitada ? (
              <div className="space-y-2">
                <textarea
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  placeholder={t("messages.reply.placeholder")}
                  maxLength={4096}
                  rows={3}
                  disabled={enviando}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-60"
                />
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={enviarRespuesta}
                    disabled={enviando || !texto.trim()}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    {t("messages.reply.enviar")}
                  </button>
                  {envioEstado === "enviado" && (
                    <span className="text-xs text-green-700">{t("messages.reply.enviado")}</span>
                  )}
                  {envioEstado === "fallo" && (
                    <span className="text-xs text-red-700">{t("messages.reply.fallo")}</span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                {respuesta.motivo === "ventana" && t("messages.reply.ventana")}
                {respuesta.motivo === "agente_activo" && t("messages.reply.agenteActivo")}
                {respuesta.motivo === "canal" && t("messages.reply.canal")}
              </p>
            )}
          </div>
        )}
      </div>
    </Marco>
  );
}
