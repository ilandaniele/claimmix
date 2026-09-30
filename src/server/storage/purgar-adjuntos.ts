/**
 * La purga diferida de adjuntos (B19): borra de R2 los objetos de casos que ya
 * no existen, pasada la gracia.
 *
 * Borrar un caso arrastra en cascada a `claim_attachments`, y con ella el único
 * puntero al objeto de R2. Por eso el borrado los anota antes en
 * `adjuntos_por_purgar` (ver `deleteCases`), y este barrido es el que los borra.
 * Cuelga del cron `reap-stuck`, dentro de la ventana diaria.
 *
 * Con el rol dueño y sin inquilino: es un barrido de sistema y `claimmix_app`
 * sólo encola en esa tabla (SELECT e INSERT, sin UPDATE ni DELETE).
 *
 * Idempotente y recuperable a propósito:
 *
 *   · Un DeleteObject simple, uno por objeto. Borrar una clave que ya no está
 *     también contesta bien, así que repetir una corrida no rompe nada.
 *   · Se marca al final, con una sola sentencia. Si se corta a mitad de camino,
 *     lo borrado y no marcado se vuelve a borrar mañana.
 *   · Un fallo suma un intento y guarda la causa; a los cinco intentos la fila
 *     deja de entrar (queda a la vista para el dueño) en vez de reintentarse
 *     para siempre.
 *   · La cola sólo se agrega y el path no es único: si dos casos compartían un
 *     objeto, cada borrado dejó su fila y manda la MÁS NUEVA (su gracia y su
 *     cancelación). Las más viejas no se purgan solas; se cierran junto con ella.
 *   · Un objeto que un adjunto VIVO todavía apunta no se toca. No debería pasar
 *     —la ruta es única por objeto—, pero borrar de R2 no tiene vuelta atrás y
 *     comprobarlo cuesta una subconsulta.
 *
 * Nace APAGADA (`PURGA_ADJUNTOS_MODO`): `simular` sólo cuenta, `borrar` borra.
 * El dueño puede cancelar una purga con `purgar_despues = NULL`.
 */

import "server-only";

import { and, asc, eq, gt, isNull, lt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { leerModo, type ModoDeBorrado } from "@/core/retencion";
import { db } from "@/lib/db";
import { adjuntosPorPurgar, claimAttachments } from "@/lib/db/schema";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { logger } from "@/lib/observability/logger";
import { deleteAttachment } from "@/server/storage/claim-attachments-bucket";

/** Cuántos objetos por corrida: cada uno es un viaje a R2, y lo que hoy no entra entra mañana. */
const POR_CORRIDA = 50;

/** A los cinco fallos la fila deja de reintentarse hasta que alguien la mire. */
const INTENTOS_MAXIMOS = 5;

/**
 * La causa que queda en la fila. Fija a propósito: `deleteAttachment` no expone el
 * error del SDK, y una cadena de afuera en una tabla podría llevar una clave o una ruta.
 */
const CAUSA_DEL_FALLO = "no se pudo borrar el objeto en R2";

export type ResultadoPurga = {
  modo: ModoDeBorrado;
  /** Los objetos vencidos que la corrida miró. */
  candidatos: number;
  purgados: number;
  fallidos: number;
};

type Pendiente = { id: string; tenant_id: string; case_id: string; storage_path: string };

/** Las demás filas de la cola, para saber si hay una más nueva del mismo objeto. */
const masNueva = alias(adjuntosPorPurgar, "mas_nueva");

/** Los vencidos, los más viejos primero. */
async function vencidos(): Promise<Pendiente[]> {
  // sin-inquilino: Barrido de sistema: la cola es de TODOS los inquilinos y el
  // rol de la aplicación no puede actualizarla ni borrarla, sólo encolar.
  return db
    .select({
      id: adjuntosPorPurgar.id,
      tenant_id: adjuntosPorPurgar.tenant_id,
      case_id: adjuntosPorPurgar.case_id,
      storage_path: adjuntosPorPurgar.storage_path,
    })
    .from(adjuntosPorPurgar)
    .where(
      and(
        // Un `purgar_despues` nulo es una purga cancelada: la comparación da nulo y no entra.
        lt(adjuntosPorPurgar.purgar_despues, sql`now()`),
        isNull(adjuntosPorPurgar.purgado_en),
        lt(adjuntosPorPurgar.intentos, INTENTOS_MAXIMOS),
        notExists(
          // sin-inquilino: la subconsulta del mismo barrido: ¿otro borrado del mismo objeto, más nuevo? Ése manda.
          db
            .select({ uno: sql`1` })
            .from(masNueva)
            .where(
              and(
                eq(masNueva.storage_path, adjuntosPorPurgar.storage_path),
                gt(masNueva.encolado_en, adjuntosPorPurgar.encolado_en)
              )
            )
        ),
        notExists(
          // sin-inquilino: la subconsulta del mismo barrido: ¿algún adjunto de cualquier inquilino apunta todavía a este objeto?
          db
            .select({ uno: sql`1` })
            .from(claimAttachments)
            .where(eq(claimAttachments.storage_path, adjuntosPorPurgar.storage_path))
        )
      )
    )
    .orderBy(asc(adjuntosPorPurgar.purgar_despues))
    .limit(POR_CORRIDA);
}

/**
 * Una sola sentencia marca todo lo de la corrida: lo borrado como purgado, lo que falló con un intento más.
 * Un objeto borrado cierra también las filas más viejas de su mismo path, que ya no tienen nada que purgar.
 */
async function marcar(resultados: Array<{ id: string; ok: boolean; storage_path: string }>): Promise<void> {
  const valores = sql.join(
    resultados.map((r) => sql`(${r.id}::uuid, ${r.ok}::boolean, ${r.storage_path}::text)`),
    sql`, `
  );
  // sin-inquilino: el mismo barrido de sistema de arriba, marcando lo que hizo.
  await db.execute(sql`
    update ${adjuntosPorPurgar} as a set
      purgado_en = case when v.ok then now() else a.purgado_en end,
      intentos = case when v.ok then a.intentos else a.intentos + 1 end,
      ultimo_error = case when v.ok then null else ${CAUSA_DEL_FALLO}::text end
    from (values ${valores}) as v(id, ok, storage_path)
    where a.purgado_en is null and (a.id = v.id or (v.ok and a.storage_path = v.storage_path))`);
}

/**
 * Un DELETE de R2 por cada adjunto vencido, hasta `hasta` (milisegundos de reloj).
 *
 * @returns `null` si la purga está apagada, sin haber consultado nada.
 */
export async function purgarAdjuntos({ hasta }: { hasta: number }): Promise<ResultadoPurga | null> {
  const modo = leerModo(process.env.PURGA_ADJUNTOS_MODO);
  if (modo === "apagado") return null;

  const pendientes = await vencidos();

  if (modo === "simular") {
    logger.info({ candidatos: pendientes.length }, "purga_adjuntos.simulada");
    return { modo, candidatos: pendientes.length, purgados: 0, fallidos: 0 };
  }

  const hechos: Array<{ pendiente: Pendiente; ok: boolean }> = [];
  for (const pendiente of pendientes) {
    if (Date.now() >= hasta) break;
    hechos.push({ pendiente, ok: await deleteAttachment(pendiente.storage_path) });
  }

  if (hechos.length > 0) await marcar(hechos.map((h) => ({ id: h.pendiente.id, ok: h.ok, storage_path: h.pendiente.storage_path })));

  /*
   * Un rastro por caso, sólo con conteos: lo que se borró y lo que no. Sin paths ni
   * nombres de archivo, que son datos del denunciante. Va DESPUÉS de marcar:
   * `writeAuditLog` no tira, y un rastro que no se pudo escribir no desmarca lo ya purgado.
   */
  const porCaso = new Map<string, { tenant_id: string; purgados: number; fallidos: number }>();
  for (const { pendiente, ok } of hechos) {
    const cuenta = porCaso.get(pendiente.case_id) ?? { tenant_id: pendiente.tenant_id, purgados: 0, fallidos: 0 };
    if (ok) cuenta.purgados++;
    else cuenta.fallidos++;
    porCaso.set(pendiente.case_id, cuenta);
  }
  for (const [caseId, { tenant_id, purgados, fallidos }] of porCaso) {
    await writeAuditLog({
      tenant_id,
      actor_id: null,
      event_type: AuditEvent.ADJUNTOS_PURGADOS,
      target_type: "case",
      target_id: caseId,
      payload: { purgados, fallidos },
    });
  }

  const purgados = hechos.filter((h) => h.ok).length;
  return { modo, candidatos: pendientes.length, purgados, fallidos: hechos.length - purgados };
}
