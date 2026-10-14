/**
 * Lo que comparten los tres clientes de Graph del alta (`alta-de-numero.ts`,
 * `embedded-signup.ts` y `app-del-cliente.ts`): cómo se arma un pedido, cómo se
 * clasifica lo que contesta Meta y qué queda anotado de una falla.
 *
 * Reglas de seguridad que los tests fijan:
 *
 *   - El token viaja sólo en `Authorization`; los secretos y los datos, en el cuerpo.
 *   - El `appsecret_proof` (un HMAC del token, no el secreto) va en el cuerpo de los
 *     POST y en la consulta de los GET y los DELETE, que no tienen cuerpo (Q24).
 *   - De un error sólo queda `{paso, status, codigo}`. Ni el token, ni la prueba, ni
 *     el cuerpo de lo que Meta contestó se anotan.
 *   - La ruta es un nodo, a lo sumo un borde y a lo sumo una consulta, y cada segmento
 *     va codificado: nada que llegue como ruta cambia el host ni sale de la versión.
 */

import "server-only";
import { logger } from "@/lib/observability/logger";
import { urlDeGraph } from "@/server/whatsapp/cloud-api";

/** Lo que se espera a Graph antes de darlo por caído. */
export const PLAZO_GRAPH_MS = 10_000;

export type FallaDeGraph = "esperar" | "meta" | "rechazo";

/** `subcodigo` sólo viene cuando Graph lo informó: separa, por ejemplo, un 190 de token vencido de uno revocado. */
export type RespuestaDeAlta<T> =
  | { ok: true; valor: T }
  | { ok: false; falla: FallaDeGraph; codigo: number | null; subcodigo?: number | null };

export type Falla = Extract<RespuestaDeAlta<never>, { ok: false }>;

/** Meta pide aflojar con estos códigos, venga el status que venga. */
const CODIGOS_DE_ESPERA = new Set([4, 80007, 130429, 133016]);

/** Qué hacer con lo que Meta contestó, venga o no con un `code`. `status` es null si ni hubo respuesta. */
export function clasificar(status: number | null, codigo: number | null): FallaDeGraph {
  if (status === 429 || (codigo !== null && CODIGOS_DE_ESPERA.has(codigo))) return "esperar";
  if (status === null || status >= 500) return "meta";
  return status >= 400 ? "rechazo" : "meta";
}

/** El pedido que ni salió: un id con forma rara, una app sin configurar o uno de la plataforma. No es culpa de Meta. */
export const SIN_PEDIDO: Falla = { ok: false, falla: "rechazo", codigo: null };

export function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function errorDeGraph(cuerpo: unknown): { codigo: number | null; subcodigo: number | null } {
  const error = objeto(objeto(cuerpo)?.error);
  return {
    codigo: typeof error?.code === "number" ? error.code : null,
    subcodigo: typeof error?.error_subcode === "number" ? error.error_subcode : null,
  };
}

/** La falla de una respuesta de Graph que no fue 2xx, sin anotarla: quien la anota es el cliente de cada vía. */
export function armarFalla(status: number | null, codigo: number | null, subcodigo: number | null = null): Falla {
  const f: Falla = { ok: false, falla: clasificar(status, codigo), codigo };
  return subcodigo === null ? f : { ...f, subcodigo };
}

export interface Pedido {
  metodo?: "GET" | "POST" | "DELETE";
  /** El valor entero de la cabecera. */
  autorizacion?: string;
  /** Un POST con formulario: aquí van los secretos. */
  formulario?: Record<string, string>;
  json?: Record<string, unknown>;
  /** El `appsecret_proof` del token del cliente: sólo con su app propia. */
  prueba?: string;
  /** La respuesta puede ser texto plano en vez de JSON (`oauth/access_token`): se devuelve el texto si no es JSON. */
  puedeSerTexto?: boolean;
}

export type Contestacion = { ok: true; cuerpo: unknown } | { ok: false; falla: Falla };

/** `nodo`, `nodo/borde`, y detrás una consulta sin `#`: ni `..`, ni `//`, ni `@`, nada que la URL lea como otro host u otro camino. */
const RUTA_DE_GRAPH = /^(\w+)(?:\/(\w+))?(?:\?([\w.,=&%-]+))?$/;

/** La ruta revisada, con cada segmento codificado; null si no tiene forma de ruta de Graph. */
export function rutaDeGraph(ruta: string): string | null {
  const m = RUTA_DE_GRAPH.exec(ruta);
  if (!m) return null;
  const [, nodo, borde, consulta] = m;
  const camino = borde === undefined ? encodeURIComponent(nodo) : `${encodeURIComponent(nodo)}/${encodeURIComponent(borde)}`;
  return consulta === undefined ? camino : `${camino}?${consulta}`;
}

/** `registro` es el nombre con que se anotan las fallas del cliente: el único dato que cambia entre los tres. */
export function clienteDeGraph<Paso extends string>(registro: string) {
  function anotar(paso: Paso, status: number | null, codigo: number | null): void {
    logger.warn({ paso, status, codigo }, registro);
  }

  function falla(paso: Paso, status: number | null, codigo: number | null, subcodigo: number | null = null): Falla {
    anotar(paso, status, codigo);
    return armarFalla(status, codigo, subcodigo);
  }

  /** Un 2xx que no trae lo esperado: se anota y no se interpreta. */
  const respuestaRara = (paso: Paso) => falla(paso, 200, null);

  /** Meta contestó y dijo que no con una respuesta de 2xx (un token que no pasa la revisión). */
  function rechazada(paso: Paso, codigo: number | null): Falla {
    anotar(paso, 200, codigo);
    return { ok: false, falla: "rechazo", codigo };
  }

  async function llamar(paso: Paso, ruta: string, pedido: Pedido): Promise<Contestacion> {
    const camino = rutaDeGraph(ruta);
    if (!camino) return { ok: false, falla: SIN_PEDIDO };
    const { formulario, json, prueba } = pedido;
    const metodo = pedido.metodo ?? (formulario || json ? "POST" : "GET");
    const headers: Record<string, string> = {};
    if (pedido.autorizacion) headers.Authorization = pedido.autorizacion;
    let body: string | undefined;
    if (json) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(metodo === "POST" && prueba ? { ...json, appsecret_proof: prueba } : json);
    } else if (formulario || (metodo === "POST" && prueba)) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(metodo === "POST" && prueba ? { ...formulario, appsecret_proof: prueba } : formulario).toString();
    }

    let res: Response;
    try {
      res = await fetch(urlDeGraph(camino, metodo === "POST" ? undefined : prueba), {
        method: metodo,
        headers,
        body,
        signal: AbortSignal.timeout(PLAZO_GRAPH_MS),
      });
    } catch {
      return { ok: false, falla: falla(paso, null, null) };
    }

    let cuerpo: unknown;
    if (pedido.puedeSerTexto) {
      const contenido = await res.text().catch(() => "");
      try {
        cuerpo = JSON.parse(contenido);
      } catch {
        cuerpo = contenido.trim();
      }
    } else {
      cuerpo = await res.json().catch(() => null);
    }
    if (!res.ok) {
      const { codigo, subcodigo } = errorDeGraph(cuerpo);
      return { ok: false, falla: falla(paso, res.status, codigo, subcodigo) };
    }
    return { ok: true, cuerpo };
  }

  /** La respuesta como objeto; cualquier otra cosa es un 2xx que no trae lo esperado. */
  async function pedirObjeto(paso: Paso, ruta: string, pedido: Pedido): Promise<RespuestaDeAlta<Record<string, unknown>>> {
    const r = await llamar(paso, ruta, pedido);
    if (!r.ok) return r.falla;
    const datos = objeto(r.cuerpo);
    return datos ? { ok: true, valor: datos } : respuestaRara(paso);
  }

  /** Un pedido que Meta confirma con `success: true`. */
  async function confirmada(paso: Paso, ruta: string, pedido: Pedido): Promise<RespuestaDeAlta<true>> {
    const r = await pedirObjeto(paso, ruta, pedido);
    if (!r.ok) return r;
    return r.valor.success === true ? { ok: true, valor: true } : respuestaRara(paso);
  }

  return { falla, respuestaRara, rechazada, llamar, pedirObjeto, confirmada };
}
