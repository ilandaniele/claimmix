import { redactString } from "@/lib/audit/redact";

/** Lo que mira el tachado; supertipo estructural de `ErrorEvent` de @sentry/nextjs. */
export interface EventoDeSentry {
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
  };
  extra?: Record<string, unknown>;
  user?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
}

const CABECERAS_QUE_QUEDAN = new Set([
  "user-agent",
  "content-type",
  "accept",
  "accept-language",
  "x-vercel-id",
]);
const CLAVE_SECRETA = /cookie|authorization|token|secret|password|api[_-]?key|session/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PATENTE_NUMERICA_RE = /\b\d{3}[-.]?\d{3}[-.]?\d{3}\b/g; // la que ya tenía el config

/** DNI, póliza, patente (las dos formas) y correo, en un texto. */
export function tacharTexto(texto: string): string {
  return redactString(texto).replace(PATENTE_NUMERICA_RE, "[PATENTE]").replace(EMAIL_RE, "[EMAIL]");
}

/** Recursivo: strings por `tacharTexto`; claves secretas → "[TACHADO]"; claves intactas. */
export function tacharValor(valor: unknown): unknown {
  if (typeof valor === "string") return tacharTexto(valor);
  if (Array.isArray(valor)) return valor.map(tacharValor);
  if (valor !== null && typeof valor === "object") {
    const resultado: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      resultado[clave] = CLAVE_SECRETA.test(clave) ? "[TACHADO]" : tacharValor(v);
    }
    return resultado;
  }
  return valor;
}

/**
 * El evento sin datos de personas ni credenciales. Nunca tira: si algo se
 * rompe adentro devuelve `null` y Sentry descarta el evento, que es mejor que
 * mandarlo crudo.
 */
export function limpiarEventoDeSentry<E extends EventoDeSentry>(event: E): E | null {
  try {
    if (event.exception?.values) {
      for (const v of event.exception.values) {
        if (v.value !== undefined) v.value = tacharTexto(v.value);
      }
    }
    if (event.message !== undefined) event.message = tacharTexto(event.message);
    if (event.breadcrumbs) {
      for (const b of event.breadcrumbs) {
        if (b.message !== undefined) b.message = tacharTexto(b.message);
        if (b.data !== undefined) b.data = tacharValor(b.data) as Record<string, unknown>;
      }
    }
    if (event.request) {
      delete event.request.data;
      delete event.request.cookies;
      if (event.request.headers) {
        const headers: Record<string, string> = {};
        for (const [clave, valor] of Object.entries(event.request.headers)) {
          if (CABECERAS_QUE_QUEDAN.has(clave.toLowerCase())) headers[clave] = valor;
        }
        event.request.headers = headers;
      }
      if (event.request.url !== undefined) event.request.url = tacharTexto(event.request.url);
      if (event.request.query_string !== undefined) {
        event.request.query_string =
          typeof event.request.query_string === "string"
            ? tacharTexto(event.request.query_string)
            : tacharValor(event.request.query_string);
      }
    }
    if (event.extra !== undefined) event.extra = tacharValor(event.extra) as Record<string, unknown>;
    if (event.tags !== undefined) event.tags = tacharValor(event.tags) as Record<string, unknown>;
    if (event.contexts !== undefined) event.contexts = tacharValor(event.contexts) as Record<string, unknown>;
    if (event.user !== undefined) {
      if (event.user.id !== undefined) event.user = { id: event.user.id };
      else delete event.user;
    }
    return event;
  } catch {
    return null;
  }
}
