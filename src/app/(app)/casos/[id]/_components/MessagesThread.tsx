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
 * Fetches GET /api/cases/[caseId]/messages on mount and then polls it while
 * the tab is visible, so inbound messages and the reply box show up alone.
 * Uses collapsible cards (click to expand full body_text up to 2000 chars from API).
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useT, useLocale } from "@/lib/i18n/LocaleContext";
import type { Locale, ClaveDelCliente } from "@/lib/i18n";
import type { MensajeDeLaConversacion as Message } from "@/server/cases/conversacion";
import type { EstadoDeRespuesta } from "@/core/whatsapp/puede-responder";
import { BloqueoPlanPro } from "@/app/(app)/_components/BloqueoPlanPro";
import { ENCABEZADO_TRANSCRIPCION } from "@/core/adjuntos/transcripcion";

/** Lo que contesta `GET /api/cases/:id/messages`. */
interface RespuestaDeMensajes {
  messages: Message[];
  recortada: boolean;
  respuesta: EstadoDeRespuesta;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

// Mismo ritmo que la bandeja (useCasesRealtime): cada pedido pasa por el
// limitador de CASES_API, que comparte con ella.
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 30_000;

// ── Constants ─────────────────────────────────────────────────────────────────

const PREVIEW_MAX_CHARS = 300;
const SUBJECT_MAX_CHARS = 60;
// Meta cierra la ventana de servicio a las 24 h en hora de Meta, pero se lo
// mostramos a quien contesta en su huso: el equipo trabaja desde Argentina.
const TIMEZONE = "America/Argentina/Buenos_Aires";

/*
 * Lo saliente que no llegó, o no se sabe si llegó, lo dice. 'queued' es un
 * mail que no terminó de salir: el envío se cortó o no se pudo anotar cómo
 * terminó.
 */
const ESTADOS: Record<string, { clave: ClaveDelCliente; clase: string }> = {
  failed: { clave: "messages.thread.no_enviado", clase: "bg-red-50 text-red-700" },
  queued: { clave: "messages.thread.sin_confirmar", clase: "bg-amber-50 text-amber-800" },
  skipped_simulated: { clave: "messages.thread.simulado", clase: "bg-amber-50 text-amber-800" },
};

// ── Relative time formatter ────────────────────────────────────────────────────

function formatRelative(isoTimestamp: string, locale: Locale): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
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

/** Día y hora (HH:mm, 24 h) del vencimiento de la ventana, en hora argentina. */
function formatVenceEn(isoTimestamp: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(isoTimestamp));
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
  locale: Locale;
}

/** Por quién firma cada tarjeta saliente: el agente o una persona del equipo (P8). */
const AUTOR_CLAVE: Record<Message["autor"], ClaveDelCliente> = {
  denunciante: "messages.thread.denunciante",
  agente: "messages.thread.agente",
  equipo: "messages.thread.equipo",
};

function MessageCard({ message, locale }: MessageCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const saliente = message.direction === "outbound";
  // El servidor siempre manda `autor`; este fallback sólo cubre que falte el
  // campo (algún fixture de test), no mensajes viejos.
  const autor = t(
    AUTOR_CLAVE[message.autor] ?? (saliente ? "messages.thread.agente" : "messages.thread.denunciante")
  );
  const canal = t(message.provider === "whatsapp" ? "messages.thread.canalWhatsapp" : "messages.thread.canalMail");
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
  // El encabezado de la transcripción se guarda en castellano dentro del texto.
  const bodyText = (message.body_text ?? "")
    .split(ENCABEZADO_TRANSCRIPCION)
    .join(t("messages.thread.encabezadoTranscripcion"));
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
                <span className="flex-shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-500">
                  {canal}
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
                {message.transcripcion && (
                  <span className="flex-shrink-0 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                    {t("messages.thread.transcripcion")}
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
                title={new Date(message.received_at).toLocaleString(locale)}
              >
                {formatRelative(message.received_at, locale)}
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
  /** Estado del caso: si cambia (Tomar el control, devolver al agente) se vuelve a pedir la conversación. */
  estado: string;
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

export function MessagesThread({ caseId, estado }: MessagesThreadProps) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });
  // La última respuesta, para saber si el sondeo trajo algo nuevo.
  const ultimoRef = useRef<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [messages, setMessages] = useState<Message[]>([]);
  const [recortada, setRecortada] = useState(false);
  const [respuesta, setRespuesta] = useState<EstadoDeRespuesta | null>(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [envioEstado, setEnvioEstado] = useState<"enviado" | "fallo" | null>(null);

  // No usar el estado después de desmontar: sigue vivo entre la carga inicial
  // y el refetch que sigue a un envío, así que no alcanza con la limpieza de
  // un solo useEffect.
  const cancelledRef = useRef(false);
  useEffect(() => {
    // StrictMode corre montaje -> limpieza -> montaje sobre la misma ref: sin
    // este reinicio, la limpieza deja la bandera en true y el segundo montaje
    // la hereda, así que el fetch que sigue nunca llega a pisar el estado.
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Aparte del efecto de montaje para poder llamarla de nuevo después de un
  // envío (F): así el estado "Para responder" del encabezado no queda viejo.
  //
  // `silencioso` es el refetch que sigue a un POST que ya salió (o quedó
  // anotado): si ese GET falla no hay que tapar el hilo ni el "Enviado." con
  // la pantalla de error genérica, sólo se pierde la actualización.
  //
  // Devuelve si la respuesta cambió respecto de la anterior.
  const fetchMessages = useCallback(async (opciones: { silencioso?: boolean } = {}) => {
    try {
      const res = await fetch(`/api/cases/${caseId}/messages`);

      if (!res.ok) {
        if (!cancelledRef.current && !opciones.silencioso) setLoadState("error");
        return false;
      }

      const data: RespuestaDeMensajes = await res.json();
      const firma = JSON.stringify(data);
      const cambio = ultimoRef.current !== null && firma !== ultimoRef.current;
      ultimoRef.current = firma;
      if (!cancelledRef.current) {
        setMessages(data.messages);
        setRecortada(data.recortada);
        setRespuesta(data.respuesta);
        setLoadState("ready");
      }
      return cambio;
    } catch {
      // Network failure — show error state, salvo que sea un refetch silencioso.
      if (!cancelledRef.current && !opciones.silencioso) setLoadState("error");
      return false;
    }
  }, [caseId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMessages();
  }, [fetchMessages]);

  // Lo que escribe la persona entra por el worker, no por esta pantalla: se
  // sondea mientras la pestaña está a la vista, de 5 s hasta 30 s si no hay
  // novedades. Con novedades se refresca la página, porque el agente pudo
  // haber cambiado el estado del caso. Un cambio de `estado` reinicia el sondeo
  // con un pedido en el acto: así la caja aparece sola después de «Tomar el
  // control», sin recargar.
  useEffect(() => {
    let cancelado = false;
    let enVuelo = false;
    let demora = POLL_MIN_MS;
    let timerId = 0;

    async function sondear(): Promise<boolean> {
      if (enVuelo || document.visibilityState === "hidden") return false;
      enVuelo = true;
      try {
        return await fetchMessages({ silencioso: true });
      } finally {
        enVuelo = false;
      }
    }

    function programar(ms: number) {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        void sondear().then((hubo) => {
          if (cancelado) return;
          if (hubo) routerRef.current.refresh();
          demora = hubo ? POLL_MIN_MS : Math.min(demora * 2, POLL_MAX_MS);
          programar(demora);
        });
      }, ms);
    }

    function alVolver() {
      if (cancelado || document.visibilityState !== "visible") return;
      demora = POLL_MIN_MS;
      programar(0);
    }

    // Sin datos todavía, la carga inicial ya está en camino.
    programar(ultimoRef.current === null ? POLL_MIN_MS : 0);
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      cancelado = true;
      window.clearTimeout(timerId);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [fetchMessages, estado]);

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
        // El envío puede haber cerrado la ventana o terminado el turno de
        // responder: se vuelve a pedir el estado, no se lo supone. Silencioso:
        // si este GET falla, el envío ya salió y no hay que tapar el "Enviado.".
        await fetchMessages({ silencioso: true });
        router.refresh();
      } else {
        const cuerpo = await res.json().catch(() => null);
        const motivo = cuerpo?.error?.details?.motivo;
        if (res.status === 403) {
          setRespuesta({ habilitada: false, motivo: "plan", vence_en: null });
        } else if (res.status === 409 && motivo) {
          setRespuesta({ habilitada: false, motivo, vence_en: null });
        } else {
          // 5xx u otro error sin motivo reconocido: puede haber quedado una
          // fila "queued" o "failed" escrita antes de que Meta contestara — se
          // la trae también acá para que se vea antes de reintentar.
          setEnvioEstado("fallo");
          await fetchMessages({ silencioso: true });
        }
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
            <MessageCard key={message.id} message={message} locale={locale} />
          ))}
        </div>
        {respuesta && respuesta.motivo !== "rol" && (
          <div className="mt-4 border-t border-slate-200 pt-4">
            {respuesta.motivo === "plan" ? (
              <BloqueoPlanPro t={t} funcion={t("planPro.responder")} />
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
                {respuesta.vence_en && (
                  <p className="text-xs text-slate-500">
                    {t("messages.reply.venceEn").replace("{fecha}", formatVenceEn(respuesta.vence_en, locale))}
                  </p>
                )}
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
