/**
 * El aviso al operador cuando el alta se acerca a su tope diario.
 *
 * Con el alta abierta, el tope de 24 h (`ALTA_TOPE_GLOBAL_DIA`) es lo que cuida
 * el costo de las pruebas. Cuando se llena, el alta se cierra en silencio para la
 * persona siguiente; el operador tiene que enterarse antes, y una sola vez por
 * día: sin tope propio, cada alta posterior al 80 % repetiría el mail.
 *
 * Sale por el remitente del sistema, con sus topes de siempre, a cada dirección de
 * `ADMIN_EMAILS`. El mail no lleva datos de nadie: sólo los números. Corre en
 * `after()`, ya contestada la persona, y nunca lanza.
 *
 * El otro aviso de acá es el del número de WhatsApp por código: cuando un número
 * queda en revisión, o cuando entra a la WABA, el operador se entera para
 * conectarlo a mano o borrar lo que sobre. Mismo remitente, misma regla: ningún
 * dato de nadie en el mail.
 *
 * Y el resumen diario (`resumenDeAltas`): lo que antes había que ir a mirar a /admin/altas.
 */

import "server-only";

import { resolveBaseURL } from "@/lib/auth/base-url";
import { operatorEmails } from "@/lib/auth/operator-emails";
import { pruebaVencida } from "@/lib/billing/plans";
import { getT } from "@/lib/i18n";
import { logger } from "@/lib/observability/logger";
import { liberarCupo, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import {
  enviarCorreoDelSistema,
  remitenteDelSistema,
  type TipoDeCorreo,
} from "@/server/notify/remitente-sistema";

const DIA_MS = 24 * 60 * 60_000;
/** Desde qué parte del tope se avisa. */
export const FRACCION_DEL_AVISO = 0.8;

/** ¿Ya van tantas altas como para avisar? Con el alta cerrada por configuración (tope 0), no. */
export function llegoAlAviso(creadas24h: number, tope: number): boolean {
  return tope > 0 && creadas24h / tope >= FRACCION_DEL_AVISO;
}

/** Los umbrales de aviso de un tope, en % del tope: el de siempre y el tope lleno. */
export type UmbralDeAviso = 80 | 100;

/**
 * El umbral más alto que `usado` ya cruzó del `tope`, o null. Sin tope (0 o menos) no hay contra qué
 * medir: para unos es «sin límite» y para otros «parado a propósito», y en los dos casos avisar es ruido.
 */
export function umbralDelTope(usado: number, tope: number): UmbralDeAviso | null {
  if (!(tope > 0)) return null;
  if (usado >= tope) return 100;
  return llegoAlAviso(usado, tope) ? 80 : null;
}

/** Las direcciones de operación, o ninguna si no hay casilla remitente por la que escribirles. */
export function destinatariosDeOperacion(): string[] {
  return remitenteDelSistema() ? operatorEmails() : [];
}

/** Manda el mismo mail a cada dirección y dice si salió a alguna: si a ninguna, el aviso no se dio. */
export async function mandarAlOperador(
  destinatarios: string[],
  asunto: string,
  texto: string,
  tipo: TipoDeCorreo
): Promise<boolean> {
  const resultados = await Promise.all(
    destinatarios.map((to) => enviarCorreoDelSistema({ to, asunto, texto }, { tipo }))
  );
  return resultados.some((r) => r.enviado);
}

export async function avisarAlOperador(creadas24h: number, tope: number): Promise<void> {
  try {
    logger.warn({ creadas24h, tope }, "alta.cerca_del_tope");
    const destinatarios = destinatariosDeOperacion();
    if (destinatarios.length === 0) return;

    const clave = claveDeCupo("alta:aviso80");
    const cupo = await rateLimit(clave, { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    if (!cupo.allowed) {
      // El intento que el contador rechazó también se cuenta: se devuelve.
      await liberarCupo(clave, DIA_MS, cupo.ventana);
      return;
    }

    const t = getT("es-AR");
    const numeros = (texto: string) =>
      texto.replace("{creadas}", String(creadas24h)).replace("{tope}", String(tope));
    const salio = await mandarAlOperador(
      destinatarios,
      numeros(t("alta.aviso.asunto")),
      numeros(t("alta.aviso.texto")),
      "operador"
    );
    // Si no salió ninguno el aviso no se dio: mañana no, pero la próxima alta de hoy tiene que poder intentarlo.
    if (!salio) await liberarCupo(clave, DIA_MS, cupo.ventana);
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.aviso_operador_fallo");
  }
}

/** Las pruebas que vencen en tantos días o menos entran al resumen. */
export const DIAS_DE_AVISO_DE_PRUEBA = 3;

/**
 * El resumen diario de altas al operador: sale una vez por día y sólo si hay algo que mirar. Lleva
 * conteos y el enlace a /admin/altas, nunca nombres, correos ni teléfonos. Dice si salió y nunca lanza.
 *
 * Los conteos de revisión y de pruebas salen de las filas más nuevas que trae `listarAltas`, así que
 * con la lista llena (`FILAS_MAXIMAS`) son una cota inferior y se muestran como «200+», «0+»…: las
 * pruebas por vencer son de las altas más viejas, las primeras que el tope de filas deja afuera. Un
 * espacio cuenta como «en revisión o sin número» sólo si está vivo (activo, o en prueba sin vencer) y no
 * tiene número, o lo tiene pedido y sin conectar con la marca de revisión: la marca es permanente y
 * `billing_status` no pasa solo de `trial` al vencer la prueba, así que contar lo abandonado haría
 * salir el resumen todos los días.
 *
 * El cupo se toma antes de la consulta del panel y de la recorrida de Graph, que son lo caro: la
 * ventana del cron deja pasar varias corridas por día y sólo la primera tiene que trabajar. Si no hay
 * nada que mandar, o el correo no sale, se devuelve.
 */
export async function resumenDeAltas(ahora: Date = new Date()): Promise<boolean> {
  try {
    const destinatarios = destinatariosDeOperacion();
    if (destinatarios.length === 0) return false;

    const clave = claveDeCupo("alta:resumen");
    const cupo = await rateLimit(clave, { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    if (!cupo.allowed) {
      await liberarCupo(clave, DIA_MS, cupo.ventana);
      return false;
    }

    let salio = false;
    try {
      salio = await armarYMandarElResumen(destinatarios, ahora);
    } finally {
      if (!salio) await liberarCupo(clave, DIA_MS, cupo.ventana);
    }
    return salio;
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.resumen_fallo");
    return false;
  }
}

async function armarYMandarElResumen(destinatarios: string[], ahora: Date): Promise<boolean> {
  // Diferidos: el panel importa módulos que importan este, y el camino caliente de WhatsApp que
  // carga este aviso no tiene que arrastrar la base ni Graph.
  const [{ listarAltas, FILAS_MAXIMAS }, { lugaresDeLaWaba }] = await Promise.all([
    import("@/server/alta/panel-operador"),
    import("@/server/alta/lugares-de-la-waba"),
  ]);
  const [panel, waba] = await Promise.all([listarAltas(), lugaresDeLaWaba()]);
  if (panel.migracionPendiente) return false;

  const vivas = panel.altas.filter(
    (f) =>
      f.estadoDeFacturacion === "active" ||
      (f.estadoDeFacturacion === "trial" &&
        !pruebaVencida({ billing_status: f.estadoDeFacturacion, trial_ends_at: f.pruebaHasta }, ahora))
  );
  const revision = vivas.filter(
    (f) => f.numero === null || (f.numeroEnRevision && f.numero.estado === "pedido")
  ).length;
  const pruebas = panel.altas.filter((f) => {
    if (f.estadoDeFacturacion !== "trial" || !f.pruebaHasta) return false;
    const falta = Date.parse(f.pruebaHasta) - ahora.getTime();
    return falta > 0 && falta <= DIAS_DE_AVISO_DE_PRUEBA * DIA_MS;
  }).length;
  const wabaLlena = waba !== null && umbralDelTope(waba.usados, waba.tope) !== null;
  if (panel.creadas24h === 0 && revision === 0 && pruebas === 0 && !wabaLlena) return false;

  // creadas24h es un count exacto; revisión y pruebas salen de la lista, que tiene tope.
  const listaLlena = panel.altas.length >= FILAS_MAXIMAS;
  const cifra = (n: number) => (listaLlena ? `${n}+` : String(n));
  const t = getT("es-AR");
  const lineas = [
    t("alta.resumen.altas")
      .replace("{n}", () => String(panel.creadas24h))
      .replace("{tope}", () => String(panel.tope)),
    t("alta.resumen.revision").replace("{n}", () => cifra(revision)),
    t("alta.resumen.pruebas")
      .replace("{dias}", () => String(DIAS_DE_AVISO_DE_PRUEBA))
      .replace("{n}", () => cifra(pruebas)),
    ...(waba
      ? [
          t("alta.resumen.waba")
            .replace("{usados}", () => String(waba.usados))
            .replace("{tope}", () => String(waba.tope))
            .replace("{libres}", () => String(waba.libres)),
        ]
      : []),
  ];
  const texto = [
    t("alta.resumen.intro"),
    ...lineas,
    "",
    t("alta.resumen.cierre").replace("{url}", () => `${resolveBaseURL()}/admin/altas`),
  ].join("\n");
  return mandarAlOperador(destinatarios, t("alta.resumen.asunto"), texto, "resumen");
}

/**
 * Por qué un número del alta automática se mira a mano.
 *
 * `sin_nombre`: la plataforma no dio su nombre visible, y sin él no se agrega nada.
 * `pais`: el código de país no se reconoce (tabla UIT, sin los no geográficos) o, en el número por
 * código, es un +54 sin el 9 y los diez dígitos de un celular.
 * `sin_fila` y `sin_credencial`: el espacio no tiene su número pedido, o falta el
 * token o la WABA de la plataforma; quien lee «lo revisamos» tiene que tener a
 * alguien del otro lado.
 * `agregado` no es una falla: es el número que ya entró a la WABA y que el
 * operador tiene que poder borrar si el espacio no lo termina de conectar.
 * `incierto`: el pedido de agregarlo dio timeout o una respuesta rara; puede haber
 * entrado, y el operador lo busca en la WABA.
 * `de_otro_ambiente`: el número es de la lista del otro ambiente (NUMEROS_DE_DEV);
 * no se toca en Meta y alguien tiene que mirar cómo llegó acá.
 * `sin_webhook`: el número ya está registrado pero Meta no confirmó el webhook
 * propio de este ambiente; sin él lo que le escriben puede caer en el otro.
 *
 * Los de la WABA propia del cliente (Embedded Signup):
 * `canje`, `suscripcion` y `registro`: Meta rechazó ese paso y reintentar no lo arregla;
 * `revocada`: la cuenta quedó sin token, porque el cliente sacó la app o Meta la dio de baja;
 * `plantilla`: no se pudo crear `reabrir_denuncia` en su WABA;
 * `numero_ocupado`: el número o la WABA ya son de otro espacio;
 * `cupo_semanal`: se llegó al tope de WABAs nuevas por semana, de todos los espacios juntos;
 * `token_vencido` y `pago_pendiente`: Graph dijo que el token no sirve o que la WABA debe;
 * `nombre_rechazado`: Meta no aprobó el nombre visible;
 * `waba_huerfana`: una WABA que Meta tiene vinculada y no terminó de conectarse (a medias hace más de 48 h, o falló al desvincularla); la base puede ya no tenerla;
 * `cuenta_restringida`: Meta restringió, deshabilitó o sancionó la cuenta del cliente.
 *
 * Los de la vía de la app propia del cliente:
 * `secreto_invalido`: el secreto de su app ya no vale (lo cambió) y Meta lo confirmó;
 * `waba_restringida` y `waba_bloqueada`: Graph dijo que la cuenta está restringida (368) o bloqueada (131031 con la salud en BLOCKED);
 * `recordatorio`: se le mandó al cliente el recordatorio de un alta que quedó a medias hace más de 24 horas;
 * `baja_fallida`: al desconectar, Meta no dio de baja el número y sigue registrado en la API de WhatsApp.
 */
export type MotivoDeRevision =
  | "sin_lugar"
  | "ya_en_la_waba"
  | "rechazo"
  | "sin_dueno"
  | "pais"
  | "sin_nombre"
  | "sin_fila"
  | "sin_credencial"
  | "agregado"
  | "incierto"
  | "de_otro_ambiente"
  | "sin_webhook"
  | "canje"
  | "suscripcion"
  | "registro"
  | "revocada"
  | "plantilla"
  | "numero_ocupado"
  | "cupo_semanal"
  | "token_vencido"
  | "pago_pendiente"
  | "nombre_rechazado"
  | "waba_huerfana"
  | "cuenta_restringida"
  | "secreto_invalido"
  | "waba_restringida"
  | "waba_bloqueada"
  | "recordatorio"
  | "baja_fallida";

/** Los motivos con un aviso por espacio y día; el resto, uno por día para todos. */
const POR_ESPACIO: ReadonlySet<MotivoDeRevision> = new Set<MotivoDeRevision>([
  "agregado",
  "incierto",
  "sin_webhook",
  "canje",
  "suscripcion",
  "registro",
  "revocada",
  "plantilla",
  "numero_ocupado",
  "token_vencido",
  "pago_pendiente",
  "nombre_rechazado",
  "waba_huerfana",
  "cuenta_restringida",
  "secreto_invalido",
  "waba_restringida",
  "waba_bloqueada",
  "recordatorio",
  "baja_fallida",
]);

/** Lo que cambia el aviso según de qué vía es la cuenta. */
export interface OpcionesDelAviso {
  /** La cuenta es de la vía de la app propia: `revocada` suma la línea de la verificación en dos pasos (R6). */
  appPropia?: boolean;
  /** Números en la WABA de la plataforma, el nuevo incluido, y su tope: `agregado` suma cuántos lugares quedan. */
  lugares?: { usados: number; tope: number };
}

/**
 * Avisa al operador de un número del alta automática. El mail dice el motivo y
 * nada más: qué espacio fue queda sólo en el registro. Un aviso por día y motivo,
 * salvo `agregado`, `incierto` y `sin_webhook` (cada número que entra, o puede haber
 * entrado, a la WABA, o que quedó sin su webhook, tiene el suyo: el tope diario de
 * números nuevos ya acota cuántos hay) y los de la WABA propia, que van uno por día
 * y espacio. `cupo_semanal` no: es del conjunto, y un aviso por día alcanza.
 */
export async function avisarNumeroEnRevision(
  motivo: MotivoDeRevision,
  tenantId: string,
  opciones: OpcionesDelAviso = {}
): Promise<void> {
  try {
    logger.warn({ motivo, tenantId }, "alta.numero_en_revision");
    const destinatarios = destinatariosDeOperacion();
    if (destinatarios.length === 0) return;

    const porEspacio = POR_ESPACIO.has(motivo);
    const clave = porEspacio ? claveDeCupo("alta:aviso-numero", motivo, tenantId) : claveDeCupo("alta:aviso-numero", motivo);
    const cupo = await rateLimit(clave, { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    if (!cupo.allowed) {
      await liberarCupo(clave, DIA_MS, cupo.ventana);
      return;
    }

    const t = getT("es-AR");
    const dosPasos = motivo === "revocada" && opciones.appPropia ? ` ${t("alta.avisoNumero.dosPasos")}` : "";
    const lugares =
      motivo === "agregado" && opciones.lugares
        ? ` ${t("alta.avisoNumero.lugares")
            .replace("{quedan}", String(Math.max(0, opciones.lugares.tope - opciones.lugares.usados)))
            .replace("{tope}", String(opciones.lugares.tope))}`
        : "";
    const texto = t("alta.avisoNumero.texto").replace("{motivo}", `${t(`alta.avisoNumero.motivo.${motivo}`)}${dosPasos}${lugares}`);
    const salio = await mandarAlOperador(destinatarios, t("alta.avisoNumero.asunto"), texto, "operador");
    if (!salio) await liberarCupo(clave, DIA_MS, cupo.ventana);
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.aviso_numero_fallo");
  }
}
