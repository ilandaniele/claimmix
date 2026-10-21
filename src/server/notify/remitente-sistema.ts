/**
 * El remitente de todo mail de autenticación: enlaces de activación y de
 * recuperación.
 *
 * Es una casilla Gmail PROPIA de la plataforma, y no la de ninguna aseguradora.
 * Antes el enlace salía por la casilla conectada del inquilino de la persona,
 * y eso tenía dos problemas: la API de Gmail deja una copia en Enviados de esa
 * casilla (con el enlace, que mientras dura ES la credencial), y quien
 * administra esa casilla puede leerla. Con una cuenta de alta automática el
 * destinatario ni siquiera tiene relación con el inquilino.
 *
 * **La casilla NO se carga en `gmail_accounts`.** El poller de entrada sólo
 * lee las filas de esa tabla, así que ni los rebotes abren casos ni las
 * respuestas entran a ninguna bandeja. El refresh token vive en el entorno.
 *
 * ── Los topes ───────────────────────────────────────────────────────────────
 *
 * Están adentro del envío y no en cada llamador porque acá convergen todos los
 * caminos: pedir una recuperación, activar una cuenta nueva, lo que venga. Son
 * dos y se cuentan por día, **y por tipo de mail** (`TipoDeCorreo`):
 *
 *  - `alta:correos:<tipo>`, global: cuánto le cuesta a la reputación de la casilla
 *    un día entero de abuso. Pasado el tope de ese tipo no sale nada de ese tipo
 *    hasta mañana. Que sea por tipo es lo que importa: el tráfico anónimo de
 *    /registro no puede dejar sin recuperación de contraseña ni sin invitaciones
 *    a quienes ya tienen cuenta.
 *  - `alta:destinatario:<tipo>:<huella>`, por dirección: que alguien le llene la
 *    bandeja a otra persona. La clave es el hash de la dirección normalizada, así
 *    que ni la tabla del limitador guarda mails. En los dos tipos que cualquiera
 *    puede pedir sobre la dirección de otro (alta y recuperación) se cuenta
 *    además por IP: si no, tres pedidos de un tercero le gastan a la víctima el
 *    cupo del día y su propio enlace no sale.
 *
 * Los dos cierran si el contador no contesta (`fallaCerrada`): un mail que no
 * sale se pide de nuevo, uno que sale de más no se recupera.
 *
 * Nunca lanza, por lo mismo que `sendPasswordResetEmail`: quien llama no puede
 * distinguir por la demora o por un error si la dirección existe.
 *
 * **Ni la dirección ni el enlace se registran.** Sólo el motivo.
 */

import "server-only";

import { createHash } from "node:crypto";

import { logger } from "@/lib/observability/logger";
import { liberarCupo, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { topeEntero } from "@/lib/topes";
import { GmailSender } from "@/server/email/gmail/gmail-sender";
import { isSendSuccess } from "@/server/email/provider";

const DIA_MS = 24 * 60 * 60_000;
const LARGO_MAXIMO_DE_CORREO = 254;
/** Una sola dirección, sin nombre ni lista: lo que se pega después de `To:` no puede sumar destinatarios. */
const UNA_DIRECCION = /^[^\s@<>,;()"'\\]+@[^\s@<>,;()"'\\]+\.[^\s@<>,;()"'\\]+$/;

export interface RemitenteDelSistema {
  correo: string;
  refreshToken: string;
}

export type MotivoSinCorreo = "sin_remitente" | "sin_cupo" | "destinatario_invalido" | "no_salio";

export type ResultadoDeCorreo = { enviado: true } | { enviado: false; motivo: MotivoSinCorreo };

export interface CorreoDelSistema {
  to: string;
  asunto: string;
  texto: string;
}

/** Cada tipo tiene su propio cupo global: ver arriba. */
export type TipoDeCorreo = "alta" | "recuperacion" | "invitacion" | "operador" | "recordatorio";

export interface OpcionesDeCorreo {
  tipo: TipoDeCorreo;
  /** De quién viene el pedido, para los tipos que cualquiera puede pedir sobre una dirección ajena. */
  ip?: string;
}

/** Los tipos cuyo cupo por dirección se cuenta por IP. */
const TIPOS_POR_IP: ReadonlySet<TipoDeCorreo> = new Set(["alta", "recuperacion"]);

/** Gmail entrega estos dominios en la misma bandeja, con o sin puntos en la parte local. */
const DOMINIOS_DE_GMAIL: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

/**
 * La casilla de la plataforma, o null si falta el correo, el refresh token o el
 * cliente OAuth. El token sólo lo canjea el cliente que lo emitió: sin
 * `GMAIL_CLIENT_*` no sale nada, y quien pregunta no tiene que creer que hay remitente.
 */
export function remitenteDelSistema(): RemitenteDelSistema | null {
  const correo = process.env.ALTA_REMITENTE_CORREO?.trim();
  const refreshToken = process.env.ALTA_REMITENTE_REFRESH_TOKEN?.trim();
  const clienteId = process.env.GMAIL_CLIENT_ID?.trim();
  const clienteSecreto = process.env.GMAIL_CLIENT_SECRET?.trim();
  return correo && refreshToken && clienteId && clienteSecreto ? { correo, refreshToken } : null;
}

/**
 * La dirección como se cuenta: sin espacios, en minúsculas y sin el `+etiqueta`,
 * porque `ana+1@x.com` y `ana+2@x.com` son la misma bandeja. En Gmail también
 * sin los puntos, y `googlemail.com` es `gmail.com`. Null si no es una dirección
 * sola.
 */
function normalizarDestinatario(correo: string): string | null {
  const limpio = correo.trim().toLowerCase();
  if (limpio.length > LARGO_MAXIMO_DE_CORREO || !UNA_DIRECCION.test(limpio)) return null;
  const arroba = limpio.lastIndexOf("@");
  const dominio = limpio.slice(arroba + 1);
  const deGmail = DOMINIOS_DE_GMAIL.has(dominio);
  const etiquetada = limpio.slice(0, arroba).split("+")[0];
  const local = deGmail ? etiquetada.replaceAll(".", "") : etiquetada;
  return local ? `${local}@${deGmail ? "gmail.com" : dominio}` : null;
}

function huellaDelDestinatario(normalizado: string): string {
  return createHash("sha256").update(normalizado).digest("hex");
}

/** Un intento contado en el limitador, para devolverlo si el mail no sale. */
interface IntentoContado {
  clave: string;
  ventana: number;
}

export async function enviarCorreoDelSistema(
  correo: CorreoDelSistema,
  { tipo, ip }: OpcionesDeCorreo
): Promise<ResultadoDeCorreo> {
  const remitente = remitenteDelSistema();
  if (!remitente) {
    logger.warn({}, "correo_sistema.sin_remitente");
    return { enviado: false, motivo: "sin_remitente" };
  }

  const destinatario = normalizarDestinatario(correo.to);
  if (!destinatario) {
    logger.warn({}, "correo_sistema.destinatario_invalido");
    return { enviado: false, motivo: "destinatario_invalido" };
  }

  const porIp = TIPOS_POR_IP.has(tipo) && ip ? [ip] : [];
  const cupos = [
    {
      clave: claveDeCupo("alta:correos", tipo),
      limit: topeEntero("ALTA_TOPE_CORREOS_DIA"),
      cual: "global",
    },
    {
      clave: claveDeCupo("alta:destinatario", tipo, ...porIp, huellaDelDestinatario(destinatario)),
      limit: topeEntero("ALTA_TOPE_POR_DESTINATARIO_DIA"),
      cual: "destinatario",
    },
  ];

  const contados: IntentoContado[] = [];
  let enviado = false;
  try {
    for (const cupo of cupos) {
      const cuenta = await rateLimit(cupo.clave, {
        limit: cupo.limit,
        windowMs: DIA_MS,
        fallaCerrada: true,
      });
      contados.push({ clave: cupo.clave, ventana: cuenta.ventana });
      if (!cuenta.allowed) {
        logger.warn({ cupo: cupo.cual, tipo }, "correo_sistema.sin_cupo");
        return { enviado: false, motivo: "sin_cupo" };
      }
    }

    const resultado = await new GmailSender(remitente.refreshToken).send({
      // Tal cual vino: la etiqueta `+` es parte de la dirección, sólo se ignora al contar.
      to: correo.to.trim(),
      from: `ClaimMix <${remitente.correo}>`,
      subject: correo.asunto,
      textBody: correo.texto,
    });
    enviado = isSendSuccess(resultado);
    if (!enviado) logger.error({}, "correo_sistema.send_failed");
    return enviado ? { enviado: true } : { enviado: false, motivo: "no_salio" };
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.name : "UnknownError" }, "correo_sistema.error");
    return { enviado: false, motivo: "no_salio" };
  } finally {
    /*
     * Un mail que no salió no gasta cupo, y tampoco el intento que el limitador
     * contó y rechazó (Postgres cuenta los dos). `liberarCupo` sólo resta en la
     * ventana donde se contó y traga la falla de la base; con `ventana: 0`
     * (memoria, o un contador que no contestó) no tiene nada que devolver.
     */
    if (!enviado) {
      await Promise.all(contados.map((c) => liberarCupo(c.clave, DIA_MS, c.ventana)));
    }
  }
}
