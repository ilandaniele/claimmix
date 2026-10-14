/**
 * Las piezas del alta de un número de WhatsApp que no dependen de cómo se
 * consigue: los cupos que se toman y se devuelven, las salidas que se le
 * muestran a la persona (revisión, falla de Graph, número sin dueño) y el
 * webhook propio del número.
 *
 * Las comparten el número por código (`numero-automatico.ts`) y los demás
 * caminos del alta, para que cada uno no reescriba la misma lógica con matices
 * distintos. Nada de acá decide el orden de los pasos: eso es de quien llama.
 */

import "server-only";

// Con `.js`: el flujo durable empaqueta este archivo (por messenger) y Node no resuelve `next/server` sin extensión.
import { after } from "next/server.js";

import type { Locale } from "@/lib/i18n";
import { logger } from "@/lib/observability/logger";
import { liberarCupo, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { avisarNumeroEnRevision, type MotivoDeRevision } from "@/server/alta/aviso-operador";
import type { ResultadoDelNumero } from "@/server/alta/numero-resultados";
import {
  fijarWebhookDelNumero,
  webhookPropioEs,
  type CredencialDeAlta,
  type FallaDeGraph,
} from "@/server/whatsapp/alta-de-numero";
import type { WebhookDelEntorno } from "@/server/whatsapp/numeros";

/** Quién pide, sacado de la sesión y de los headers: nada de esto entra por el cuerpo de un pedido. */
export interface QuienPide {
  tenantId: string;
  userId: string;
  /** Una IP válida o null: es la clave del cupo por red y lo que anota la auditoría. */
  ip: string | null;
  idioma: Locale;
}

/* ── Cupos ────────────────────────────────────────────────────────────────── */

export interface Cupo {
  /** Cuál es, para decirle a quien llama cuál cortó. */
  cual: string;
  clave: string;
  limit: number;
  windowMs: number;
}

/** Lo que el contador anotó: lo único que hace falta para devolverlo. */
export interface Tomado {
  clave: string;
  windowMs: number;
  ventana: number;
}

export type Toma = { ok: true; tomados: Tomado[] } | { ok: false; cual: string };

/** Devuelve los intentos al contador. Nunca tira: un cupo que no vuelve no rompe lo que sigue. */
export async function soltar(tomados: Tomado[]): Promise<void> {
  await Promise.all(
    tomados.map(async (t) => {
      try {
        await liberarCupo(t.clave, t.windowMs, t.ventana);
      } catch {
        logger.warn({}, "alta.numero_cupo_no_liberado");
      }
    })
  );
}

/**
 * Toma los cupos en orden, siempre cerrando si el contador no contesta. Si uno no
 * tiene lugar devuelve todo lo tomado, también el intento que el contador contó y
 * rechazó, y dice cuál fue. Un límite 0 es «sin lugar» y no llama al contador.
 */
export async function tomar(lista: Cupo[]): Promise<Toma> {
  const tomados: Tomado[] = [];
  for (const cupo of lista) {
    if (cupo.limit <= 0) {
      await soltar(tomados);
      return { ok: false, cual: cupo.cual };
    }
    const cuenta = await rateLimit(cupo.clave, { limit: cupo.limit, windowMs: cupo.windowMs, fallaCerrada: true });
    tomados.push({ clave: cupo.clave, windowMs: cupo.windowMs, ventana: cuenta.ventana });
    if (!cuenta.allowed) {
      await soltar(tomados);
      return { ok: false, cual: cupo.cual };
    }
  }
  return { ok: true, tomados };
}

export const HORA_MS = 60 * 60_000;
export const DIA_MS = 24 * HORA_MS;
/** `register` admite unos 10 pedidos por número cada 72 h: tres por día es de sobra para quien lo hace una vez. */
export const REGISTROS_POR_DIA = 3;

/**
 * Los cupos del código del número y del registro, en un solo lugar: el número por
 * código y la WABA propia gastan las mismas cubetas (mismas claves), así que un tope
 * cambiado en un camino tiene que ser el mismo en el otro.
 */
interface TopesDeCodigo {
  codigosInquilino: number;
  codigosIp: number;
  codigosDia: number;
  verificacionesHora: number;
}

export const cuposDePedirCodigo = (tenantId: string, ip: string | null, topes: TopesDeCodigo): Cupo[] => [
  { cual: "inquilino", clave: claveDeCupo("wa:codigo", tenantId), limit: topes.codigosInquilino, windowMs: DIA_MS },
  { cual: "ip", clave: claveDeCupo("wa:codigo-ip", ip ?? "sin-ip"), limit: topes.codigosIp, windowMs: DIA_MS },
  { cual: "global", clave: claveDeCupo("wa:codigos"), limit: topes.codigosDia, windowMs: DIA_MS },
];

export const cuposDeVerificar = (tenantId: string, topes: TopesDeCodigo): Cupo[] => [
  { cual: "verificar", clave: claveDeCupo("wa:verificar", tenantId), limit: topes.verificacionesHora, windowMs: HORA_MS },
];

export const cuposDeRegistrar = (tenantId: string): Cupo[] => [
  { cual: "registrar", clave: claveDeCupo("wa:registrar", tenantId), limit: REGISTROS_POR_DIA, windowMs: DIA_MS },
];

/* ── Salidas ──────────────────────────────────────────────────────────────── */

/** Lo que devolvió la función de la base que escribe un paso del alta. */
export type Guardado =
  | "ok"
  | "no_aplica"
  | "datos_invalidos"
  | "id_de_la_plataforma"
  | "id_ocupado"
  | "sin_migracion"
  | "error";

/** Un número que se mira a mano: el aviso sale después de contestar y la persona ve «revision». */
export function aRevision(motivo: MotivoDeRevision, tenantId: string): ResultadoDelNumero {
  after(() => avisarNumeroEnRevision(motivo, tenantId));
  return "revision";
}

/** Lo que Graph dijo, como lo ve la persona: esperar y meta tal cual, un rechazo se mira a mano. */
export function deFalla(falla: FallaDeGraph, tenantId: string): ResultadoDelNumero {
  return falla === "rechazo" ? aRevision("rechazo", tenantId) : falla;
}

/** Meta tiene el número y la base no pudo asignárselo al espacio: se anota qué dijo la función y se avisa. */
export function sinDueno(quien: QuienPide, paso: "agregado" | "conectado", guardado: Guardado): ResultadoDelNumero {
  logger.error({ tenantId: quien.tenantId, paso, guardado }, "alta.numero_automatico_no_guardado");
  return aRevision("sin_dueno", quien.tenantId);
}

/* ── El webhook del número ────────────────────────────────────────────────── */

export interface Entorno {
  cred: CredencialDeAlta;
  plataforma: string;
  /** null con la app propia del cliente: el callback de su app ya apunta a la ruta del espacio y el número no lleva otro. */
  webhook: WebhookDelEntorno | null;
}

/**
 * Le pone al número el webhook de este ambiente y lo lee de Graph. null si quedó; si
 * no, qué contestar. Poner no alcanza: lo que Graph devuelve es lo único que vale.
 * Sin webhook en el entorno no hay nada que poner y no se llama a Graph.
 */
export async function fijarElWebhook(tenantId: string, id: string, entorno: Entorno): Promise<ResultadoDelNumero | null> {
  const { webhook } = entorno;
  if (!webhook) return null;
  const puesto = await fijarWebhookDelNumero(entorno.cred, id, webhook);
  if (!puesto.ok) return deFalla(puesto.falla, tenantId);
  const leido = await webhookPropioEs(entorno.cred, id, webhook.url);
  if (!leido.ok) return deFalla(leido.falla, tenantId);
  return leido.valor ? null : aRevision("sin_webhook", tenantId);
}
