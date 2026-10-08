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
