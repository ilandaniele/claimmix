import { redactString } from "@/lib/audit/redact";

/** Lo que mira el tachado; supertipo estructural de `ErrorEvent` de @sentry/nextjs. */
export interface EventoDeSentry {
  message?: string;
  transaction?: string;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
  spans?: Array<{ description?: string; data?: Record<string, unknown> }>;
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

const RUTA_DE_APP_RE = /(\/api\/webhooks\/whatsapp\/app\/)[^/?#\s"']+/g;

/**
 * La ruta del webhook de la app de un cliente (`/api/webhooks/whatsapp/app/<ruta>`)
 * no se adivina y es lo que separa su webhook de los demás: no queda en Sentry.
 */
export function sinRutaDeApp(texto: string): string {
  return texto.replace(RUTA_DE_APP_RE, "$1:ruta");
}

/** DNI, póliza, patente (las dos formas), correo y la ruta del webhook de una app, en un texto. */
export function tacharTexto(texto: string): string {
  return redactString(sinRutaDeApp(texto)).replace(PATENTE_NUMERICA_RE, "[PATENTE]").replace(EMAIL_RE, "[EMAIL]");
}

const URL_DE_META = /^https?:\/\/(?:[\w-]+\.)*facebook\.com(?::\d+)?(?=[/?#]|$)/i;

/**
 * La URL de Graph sin la consulta. Ahí viajan `access_token`, `client_secret` o
 * un `code` según el paso, y Sentry los guardaría en breadcrumbs y spans de
 * cada pedido saliente; `tacharValor` no los ve porque tacha por nombre de
 * clave, no por lo que trae la URL. Otros hosts quedan como vienen.
 */
export function sinConsultaDeMeta(url: string): string {
  if (!URL_DE_META.test(url)) return url;
  const corte = url.search(/[?#]/);
  return corte === -1 ? url : url.slice(0, corte);
}

const CLAVES_DE_URL = ["url", "url.full", "http.url"];
const CLAVES_DE_CONSULTA = ["http.query", "url.query", "http.fragment"];

/** Los datos de un breadcrumb o span: si apuntan a Meta, la URL pierde su consulta y la consulta suelta se borra. */
function sinConsultaDeMetaEnDatos(data: Record<string, unknown>): void {
  let deMeta = false;
  for (const clave of CLAVES_DE_URL) {
    const valor = data[clave];
    if (typeof valor !== "string" || !URL_DE_META.test(valor)) continue;
    data[clave] = sinConsultaDeMeta(valor);
    deMeta = true;
  }
  if (deMeta) for (const clave of CLAVES_DE_CONSULTA) delete data[clave];
}

/** Los datos de un span no pasan por `tacharValor`: sólo se les saca la ruta de la app donde haya un texto. */
function sinRutaDeAppEnDatos(data: Record<string, unknown>): void {
  for (const [clave, valor] of Object.entries(data)) {
    if (typeof valor === "string") data[clave] = sinRutaDeApp(valor);
  }
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
    if (event.transaction !== undefined) event.transaction = sinRutaDeApp(event.transaction);
    if (event.breadcrumbs) {
      for (const b of event.breadcrumbs) {
        if (b.message !== undefined) b.message = tacharTexto(b.message);
        if (b.data !== undefined) {
          sinConsultaDeMetaEnDatos(b.data);
          b.data = tacharValor(b.data) as Record<string, unknown>;
        }
      }
    }
    if (event.spans) {
      for (const span of event.spans) {
        if (span.data !== undefined) {
          sinConsultaDeMetaEnDatos(span.data);
          sinRutaDeAppEnDatos(span.data);
        }
        // La descripción de un span http es «GET <url>».
        if (span.description !== undefined) {
          span.description = sinRutaDeApp(span.description.replace(/https?:\/\/\S+/g, sinConsultaDeMeta));
        }
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
