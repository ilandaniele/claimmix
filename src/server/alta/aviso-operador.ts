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
 */

import "server-only";

import { operatorEmails } from "@/lib/auth/require-operator";
import { getT } from "@/lib/i18n";
import { logger } from "@/lib/observability/logger";
import { liberarCupo, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { enviarCorreoDelSistema, remitenteDelSistema } from "@/server/notify/remitente-sistema";

const DIA_MS = 24 * 60 * 60_000;
/** Desde qué parte del tope se avisa. */
export const FRACCION_DEL_AVISO = 0.8;

/** ¿Ya van tantas altas como para avisar? Con el alta cerrada por configuración (tope 0), no. */
export function llegoAlAviso(creadas24h: number, tope: number): boolean {
  return tope > 0 && creadas24h / tope >= FRACCION_DEL_AVISO;
}

export async function avisarAlOperador(creadas24h: number, tope: number): Promise<void> {
  try {
    logger.warn({ creadas24h, tope }, "alta.cerca_del_tope");
    if (!remitenteDelSistema()) return;
    const destinatarios = operatorEmails();
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
    const resultados = await Promise.all(
      destinatarios.map((to) =>
        enviarCorreoDelSistema(
          { to, asunto: numeros(t("alta.aviso.asunto")), texto: numeros(t("alta.aviso.texto")) },
          { tipo: "operador" }
        )
      )
    );
    // Si no salió ninguno el aviso no se dio: mañana no, pero la próxima alta de hoy tiene que poder intentarlo.
    if (!resultados.some((r) => r.enviado)) await liberarCupo(clave, DIA_MS, cupo.ventana);
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.aviso_operador_fallo");
  }
}

/**
 * Por qué un número del alta automática se mira a mano.
 *
 * `sin_nombre`: la plataforma no dio su nombre visible, y sin él no se agrega nada.
 * `sin_fila` y `sin_credencial`: el espacio no tiene su número pedido, o falta el
 * token o la WABA de la plataforma; quien lee «lo revisamos» tiene que tener a
 * alguien del otro lado.
 * `agregado` no es una falla: es el número que ya entró a la WABA y que el
 * operador tiene que poder borrar si el espacio no lo termina de conectar.
 * `incierto`: el pedido de agregarlo dio timeout o una respuesta rara; puede haber
 * entrado, y el operador lo busca en la WABA.
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
  | "incierto";

/**
 * Avisa al operador de un número del alta automática. El mail dice el motivo y
 * nada más: qué espacio fue queda sólo en el registro. Un aviso por día y motivo,
 * salvo `agregado` e `incierto`: cada número que entra (o puede haber entrado) a la
 * WABA tiene el suyo (el tope diario de números nuevos ya acota cuántos hay).
 */
export async function avisarNumeroEnRevision(motivo: MotivoDeRevision, tenantId: string): Promise<void> {
  try {
    logger.warn({ motivo, tenantId }, "alta.numero_en_revision");
    if (!remitenteDelSistema()) return;
    const destinatarios = operatorEmails();
    if (destinatarios.length === 0) return;

    const porEspacio = motivo === "agregado" || motivo === "incierto";
    const clave = porEspacio ? claveDeCupo("alta:aviso-numero", motivo, tenantId) : claveDeCupo("alta:aviso-numero", motivo);
    const cupo = await rateLimit(clave, { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    if (!cupo.allowed) {
      await liberarCupo(clave, DIA_MS, cupo.ventana);
      return;
    }

    const t = getT("es-AR");
    const texto = t("alta.avisoNumero.texto").replace("{motivo}", t(`alta.avisoNumero.motivo.${motivo}`));
    const resultados = await Promise.all(
      destinatarios.map((to) =>
        enviarCorreoDelSistema({ to, asunto: t("alta.avisoNumero.asunto"), texto }, { tipo: "operador" })
      )
    );
    if (!resultados.some((r) => r.enviado)) await liberarCupo(clave, DIA_MS, cupo.ventana);
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.aviso_numero_fallo");
  }
}
