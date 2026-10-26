/**
 * Una pregunta sobre UN caso, con la conversación guardada (B12).
 *
 * El caso llega al modelo enmascarado por rol y armado por `armarDetalle`, el
 * mismo que usa el resumen: que lea lo que ve la persona, ni un dato más. A eso
 * se suman el resumen que la IA hizo de cada documento (B8/B1) y la cobertura y
 * el monto (B6, B23), y para un viewer ninguna de las dos: son sólo del equipo.
 *
 * El modelo no elige nada acá: la herramienta ya la eligió quien apretó el
 * botón, así que no hay clasificador ni una consulta que dependa de lo que
 * conteste. Todo lo que puede hacer es contestar, y lo que contesta pasa por
 * las mismas guardas que el resumen (`resumenValido`) antes de mostrarse: sin
 * enlaces, sin centinelas y sin un número o un monto que no esté en un campo
 * del caso. Sin cupo, sin presupuesto o con el modelo caído no hay respuesta y
 * la pantalla dice «sin leer»; nunca una inventada.
 *
 * El hilo vive en `asistente_turnos`: lo lee sólo quien lo escribió (RLS por
 * inquilino Y persona) y vuelve al modelo como dato, entre su propio centinela.
 */

import "server-only";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { resumenValido } from "@/core/ai/resumen-seguro";
import { sinCentinelas } from "@/core/ai/sin-centinelas";
import type { MotivoSinLeer } from "@/core/ai/sin-leer";
import { enTenantDeUsuarioVarias, type TenantContext, type UsuarioContext } from "@/data/scope";
import type { RoleContext } from "@/lib/auth/require-role";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { redactString } from "@/lib/audit/redact";
import { asistenteTurnos } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { getT, type Locale, type TranslationKey } from "@/lib/i18n";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { leerDocumento } from "@/server/ai/leer-documento";
import { armarDetalle, type DetalleDelCaso } from "@/server/asistente/herramientas";
import { promptPreguntaCaso } from "@/server/asistente/prompts";
import type { RespuestaDelAsistente } from "@/server/asistente/responder";
import { cargarDetalleDeCaso, type DetalleDeCaso } from "@/server/cases/detail-view";
import { conversacionDelCaso } from "@/server/cases/conversacion";

/** Lo que muestra la pantalla al abrir el caso; al modelo le llegan los últimos `TURNOS_AL_MODELO`. */
export const TOPE_TURNOS_DEL_HILO = 20;
const TURNOS_AL_MODELO = 10;
const TOPE_DOCUMENTOS = 10;
const TOPE_RESUMEN_DE_DOCUMENTO = 300;
export const TOPE_RESPUESTA_DE_CASO = 1200;

export interface TurnoDelHilo {
  rol: "user" | "assistant";
  texto: string;
}

interface ContextoDelCaso {
  caso: DetalleDelCaso;
  documentos: Array<{ pedido: string | null; resumen: string; util: boolean | null }>;
  cobertura: {
    veredicto: string;
    motivos: string[];
    condiciones: string;
    monto: { minimo: number; maximo: number; moneda: string; origen: string } | null;
  } | null;
}

/**
 * Sólo lo que el modelo necesita de cada documento: qué documento pedido
 * cerró y la línea que la IA escribió de él. Nada del nombre del archivo, que
 * lo elige quien lo manda.
 */
function documentosDe(detalle: DetalleDeCaso): ContextoDelCaso["documentos"] {
  return detalle.attachments
    .filter((a) => a.resumen)
    .slice(0, TOPE_DOCUMENTOS)
    .map((a) => ({
      pedido: a.matched_doc_key,
      resumen: redactString(a.resumen!).slice(0, TOPE_RESUMEN_DE_DOCUMENTO),
      util: a.util,
    }));
}

function coberturaDe(detalle: DetalleDeCaso): ContextoDelCaso["cobertura"] {
  const c = detalle.cobertura;
  if (!c) return null;
  return {
    veredicto: c.resultado.veredicto,
    motivos: c.resultado.motivos,
    condiciones: c.condiciones,
    monto: c.monto
      ? { minimo: c.monto.minimo, maximo: c.monto.maximo, moneda: c.monto.moneda, origen: c.monto.origen }
      : null,
  };
}

/** El hilo de esta persona en este caso, del más viejo al más nuevo; el viewer lo ve con el mismo enmascarado que el caso. */
export async function hiloDelCaso(ctx: RoleContext, caseId: string): Promise<TurnoDelHilo[]> {
  const usuarioCtx: UsuarioContext = { tenantId: ctx.userRow.tenant_id, userId: ctx.user.id };
  const [filas] = await enTenantDeUsuarioVarias<[Array<TurnoDelHilo>]>(usuarioCtx, (db) => [
    db
      .select({ rol: asistenteTurnos.rol, texto: asistenteTurnos.texto })
      .from(asistenteTurnos)
      .where(eq(asistenteTurnos.case_id, caseId))
      .orderBy(desc(asistenteTurnos.id))
      .limit(TOPE_TURNOS_DEL_HILO),
  ]);
  const enOrden = filas.reverse();
  // La conversación se guardó cuando la persona podía ver esos datos; si después
  // la bajaron a viewer, lo que ya no debe ver no vuelve a salir.
  return ctx.userRow.role === "viewer" ? enOrden.map((f) => ({ ...f, texto: redactString(f.texto) })) : enOrden;
}

/** Guarda el par pregunta-respuesta. Una falla no le quita la respuesta a quien ya la pagó: se registra y sigue. */
async function guardarTurnos(ctx: RoleContext, caseId: string, pregunta: string, respuesta: string): Promise<void> {
  const tenantId = ctx.userRow.tenant_id;
  const userId = ctx.user.id;
  try {
    await enTenantDeUsuarioVarias<[unknown]>({ tenantId, userId }, (db) => [
      db.insert(asistenteTurnos).values([
        { tenant_id: tenantId, user_id: userId, case_id: caseId, rol: "user", texto: pregunta },
        { tenant_id: tenantId, user_id: userId, case_id: caseId, rol: "assistant", texto: respuesta },
      ]),
    ]);
  } catch (err) {
    logger.warn({ error_code: errorCode(err) }, "asistente.guardar_turnos_fallo");
  }
}

function sinLeer(motivo: MotivoSinLeer, locale: Locale): RespuestaDelAsistente {
  return {
    texto: getT(locale)(`lectura.sinLeer.${motivo}` as TranslationKey),
    herramienta: "pregunta_caso",
    casos: [],
    sinLeer: motivo,
  };
}

export async function preguntarSobreCaso(
  ctx: RoleContext,
  caseId: string,
  pregunta: string,
  locale: Locale
): Promise<RespuestaDelAsistente> {
  const tenantId = ctx.userRow.tenant_id;
  const userId = ctx.user.id;
  const rol = ctx.userRow.role;
  const tenantCtx: TenantContext = { tenantId };

  // Las tres lecturas van juntas: ninguna depende de la otra, y un caso ajeno las devuelve vacías.
  const [detalle, conversacion, hilo] = await Promise.all([
    cargarDetalleDeCaso(tenantCtx, caseId, rol),
    conversacionDelCaso(tenantCtx, caseId),
    hiloDelCaso(ctx, caseId).catch((err) => {
      // Sin el hilo se contesta igual, sin memoria: mejor eso que no contestar.
      logger.warn({ error_code: errorCode(err) }, "asistente.leer_hilo_fallo");
      return [] as TurnoDelHilo[];
    }),
  ]);
  if (!detalle) throw new AppError("NOT_FOUND");

  const esViewer = rol === "viewer";
  const contexto: ContextoDelCaso = {
    caso: armarDetalle(detalle, conversacion, rol),
    // Los resúmenes de documentos, la cobertura y el monto son sólo del equipo.
    documentos: esViewer ? [] : documentosDe(detalle),
    cobertura: esViewer ? null : coberturaDe(detalle),
  };

  // Lo único que la respuesta puede repetir son números que ya están en un campo del caso y el rango de la cobertura.
  const conocidos = [contexto.caso.poliza, ...contexto.caso.campos.map((c) => c.valor)];
  const monto = contexto.cobertura?.monto;
  const montos = monto ? [monto.minimo, monto.maximo] : [];
  const schema = z.object({
    respuesta: z
      .string()
      .trim()
      .refine((r) => resumenValido(r, conocidos, TOPE_RESPUESTA_DE_CASO, montos)),
  });

  const usuario =
    `<datos_del_caso>${sinCentinelas(JSON.stringify(contexto))}</datos_del_caso>\n` +
    `<historial_del_hilo>${sinCentinelas(JSON.stringify(hilo.slice(-TURNOS_AL_MODELO)))}</historial_del_hilo>\n` +
    `<pregunta_del_usuario>${sinCentinelas(pregunta)}</pregunta_del_usuario>`;

  const lectura = await leerDocumento({
    tenantId,
    userId,
    caseId,
    ambito: "asistente-caso",
    partesDeClave: [tenantId, userId, caseId],
    sistema: promptPreguntaCaso(locale, TOPE_RESPUESTA_DE_CASO),
    usuario,
    media: [],
    schema,
  });
  if ("sinLeer" in lectura) return sinLeer(lectura.sinLeer, locale);

  const texto = lectura.ok.respuesta;
  // Sin orden entre las dos escrituras: van juntas para no sumar sus viajes a la base.
  await Promise.all([
    guardarTurnos(ctx, caseId, pregunta, texto),
    writeAuditLog({
      tenant_id: tenantId,
      actor_id: userId,
      event_type: AuditEvent.ASSISTANT_QUERY,
      payload: { herramienta: "pregunta_caso", casos: 1 },
    }),
  ]);

  return { texto, herramienta: "pregunta_caso", casos: [] };
}
