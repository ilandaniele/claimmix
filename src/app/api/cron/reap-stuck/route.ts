/**
 * GET /api/cron/reap-stuck — escalate cases stuck in `procesando`.
 *
 * Daily safety-net sweep for the Vercel `after()` eviction problem: when a big
 * simulate batch exceeds the function's wall-clock budget, later cases never get
 * their AI agent run and sit in `procesando` indefinitely. This transitions any
 * such case (older than SIMULATE_STUCK_REAP_AFTER_MS, default 20 min) to
 * `escalado` so it can be re-analyzed and so the simulation queue stays clear.
 *
 * Runs once daily (Hobby-plan safe — Hobby caps crons at once per day). The
 * primary, real-time mechanism is the opportunistic reaper call that simulate
 * and batch-simulate run synchronously before queuing a new batch; this cron is
 * just a backstop for when no new simulations run for a long stretch.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (constant-time compared), same as
 * the gmail-poll cron. Vercel cron invocations include this header automatically.
 *
 * Con `BASE_POR_CLIENTE=1` cada barrido de casos corre una vez por base de cliente
 * (`paraCadaBase`), y al final la ruta vuelve a lanzar las bases que quedaron a
 * medias y espeja control en las que están listas. Apagada, todo corre una vez
 * contra la base de siempre y la respuesta es la de siempre.
 */

import { NextRequest, NextResponse } from "next/server";
import { basePorCliente } from "@/data/bases";
import { isInternalRequest } from "@/lib/security/internal-auth";
import type { DbDueno } from "@/lib/db";
import { paraCadaBase } from "@/server/bases/cada-base";
import { espejarTodas } from "@/server/bases/espejo";
import { reintentarBases } from "@/server/bases/reintentar";
import { reapStuckProcessingCases } from "@/server/intake/reap-stuck";
import { closeAbandonedConversations } from "@/server/intake/close-abandoned";
import { retomarExtraccionesPendientes } from "@/server/intake/retomar-pendientes";
import { avisarCierres, recordarPendientes } from "@/server/confirmations/recordatorios";
import { revisarDesvios, type ResultadoDeLaRevision } from "@/server/desvios/revision-nocturna";
import { avisarDesvios } from "@/server/notify/specialist-alert";
import { aplicarRetencion, type ResultadoRetencion } from "@/server/cases/retencion";
import { purgarAdjuntos, type ResultadoPurga } from "@/server/storage/purgar-adjuntos";
import { ventanaDiaria } from "@/core/retencion";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const suma = (numeros: number[]) => numeros.reduce((total, n) => total + n, 0);

/** Junta lo que devolvió cada base: con una sola (bandera apagada) es ella misma, sin tocar. */
function juntar<T extends object>(resultados: T[], sumar: (a: T, b: T) => T): T | null {
  const [primero, ...resto] = resultados;
  return primero === undefined ? null : resto.reduce(sumar, primero);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const hasta = Date.now() + maxDuration * 1000;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error({}, "cron_reap_stuck.cron_secret_is_not_configured");
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Server misconfiguration." } },
      { status: 500 }
    );
  }

  /*
   * La comparación sale de `isInternalRequest`, que es este mismo
   * `timingSafeEqual` contra `Bearer ${CRON_SECRET}` escrito una sola vez.
   *
   * Lo que NO se centraliza es el 500 de arriba. Que falte el secreto es una
   * mala configuración del despliegue y no un llamador sin permiso, y la
   * diferencia está fijada por tests a propósito.
   */
  if (!isInternalRequest(req)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing Authorization header." } },
      { status: 401 }
    );
  }

  // Lo que no entró o falló en las pasadas por las bases; con la bandera apagada queda en cero y no sale.
  const bases = { pendientes: 0, fallas: 0 };
  const porBase = async <T>(trabajo: (db: DbDueno, tenantId: string | null) => Promise<T>, hastaDelBarrido: number) => {
    const corrida = await paraCadaBase(trabajo, { hasta: hastaDelBarrido });
    bases.pendientes = Math.max(bases.pendientes, corrida.pendientes);
    bases.fallas += corrida.fallas;
    return corrida.resultados;
  };

  const trabados = await porBase((db) => reapStuckProcessingCases(undefined, db), hasta);
  const result = { reaped: suma(trabados.map((r) => r.reaped)), caseIds: trabados.flatMap((r) => r.caseIds) };

  /*
   * Y después, retomar lo que quedó marcado y sin hacer.
   *
   * `extraction_pending` la escriben cuatro caminos del worker y hasta ahora la
   * leía uno solo: el mismo proceso que la escribía. Sin este barrido, un
   * mensaje que llegó a mitad de corrida quedaba guardado y sin leer hasta que
   * la misma persona volviera a escribir — y a los catorce días el barrido de
   * abandonados lo cerraba diciendo que la persona no contestó.
   *
   * Va acá y no en su propio cron porque Hobby da dos por día y los dos ya
   * están usados. Va DESPUÉS del barrido de trabados —un pendiente que sigue
   * en `recibido` pasados los veinte minutos ya salió escalado arriba— y
   * ANTES del de abandonados, que no mira la marca. Con el reloj de la
   * invocación: veinte corridas enteras no entran en ninguna función, así que
   * se corta cuando no queda para una más.
   */
  const retomados = suma(
    (await porBase((db) => retomarExtraccionesPendientes({ hasta }, db), hasta)).map((r) => r.retomados)
  );

  // Los recordatorios (B4) van antes del cierre, con a lo sumo un minuto: un
  // caso que hoy cumple las 48 h no tiene que esperar a que se cierren los
  // viejos. Si fallan, el cierre corre igual.
  let recordatorios = { enviados: 0, salteados: 0 };
  try {
    const hastaRecordatorios = Math.min(hasta - 60_000, Date.now() + 60_000);
    const enviados = await porBase((db) => recordarPendientes({ hasta: hastaRecordatorios }, db), hastaRecordatorios);
    recordatorios = {
      enviados: suma(enviados.map((r) => r.enviados)),
      salteados: suma(enviados.map((r) => r.salteados)),
    };
  } catch (err) {
    logger.error({ code: errorCode(err) }, "cron_reap_stuck.recordatorios_fallaron");
  }

  // Same nightly pass, second sweep: conversations the claimant abandoned.
  // Piggybacking rather than adding a cron because the Hobby plan allows one
  // run a day and both jobs want exactly that cadence.
  const abandoned = {
    closed: suma((await porBase((db) => closeAbandonedConversations(db), hasta)).map((r) => r.closed)),
  };

  // El aviso de cierre (B4) busca los cierres recientes sin avisar, así que el
  // que hoy no entra sale mañana. Deja un minuto para la purga y la respuesta.
  let avisosDeCierre = 0;
  try {
    avisosDeCierre = suma(await porBase((db) => avisarCierres({ hasta: hasta - 60_000 }, db), hasta - 60_000));
  } catch (err) {
    logger.error({ code: errorCode(err) }, "cron_reap_stuck.avisos_de_cierre_fallaron");
  }

  // La revisión de calidad (B22) mira lo que quedó después de los barridos de
  // arriba, así que va después. Es idempotente: lo que hoy no entra, entra
  // mañana. Con un minuto de margen para la purga, y si falla la purga corre igual.
  //
  // Esta ruta la llama GitHub Actions cada quince minutos, pero la revisión es
  // una por día: un cupo de 24 h la deja pasar sólo a la primera llamada del día.
  // Las reglas que fallaron vuelven en la respuesta: el log solo no lo mira nadie,
  // y barrer-trabados.yml se pone rojo con ellas.
  //
  // Cada aseguradora con desvíos nuevos recibe un correo con los conteos (a lo
  // sumo uno por día, lo limita el aviso). La revisión de mañana sólo cuenta lo
  // nuevo de mañana: un aviso que hoy no entra en la función no se repite.
  let desviosNuevos = 0;
  let desviosFallidas: ResultadoDeLaRevision["fallidas"] = [];
  let avisosDeDesvios = 0;
  if (Date.now() < hasta - 60_000) {
    try {
      const cupo = await rateLimit(claveDeCupo("revision-de-desvios"), RATE_LIMIT_CONFIGS.REVISION_DE_DESVIOS);
      if (cupo.allowed) {
        const revisiones = await porBase((db) => revisarDesvios(db), hasta - 60_000);
        desviosNuevos = suma(revisiones.map((r) => r.nuevos));
        desviosFallidas = [...new Set(revisiones.flatMap((r) => r.fallidas))];
        const porInquilino = Object.assign({}, ...revisiones.map((r) => r.porInquilino)) as ResultadoDeLaRevision["porInquilino"];
        for (const [tenantId, porRegla] of Object.entries(porInquilino)) {
          if (Date.now() >= hasta - 60_000) break;
          if (await avisarDesvios({ tenantId, porRegla })) avisosDeDesvios += 1;
        }
      }
    } catch (err) {
      logger.error({ code: errorCode(err) }, "cron_reap_stuck.desvios_fallaron");
    }
  }

  // La purga de adjuntos y la retención (B19) son UNA por día. La ruta la llama
  // GitHub cada quince minutos y Vercel a las 04:07, así que la ventana de las 04
  // UTC sola deja pasar cinco corridas en esa hora: los cinco intentos de la purga se
  // gastarían de una vez y dos corridas encimadas contarían el mismo fallo dos veces.
  // El cupo de 24 h deja pasar sólo a la primera de la ventana, y se pide DENTRO de
  // ella para que la llamada de las 00 UTC no lo gaste. Las dos nacen apagadas y van
  // detrás de todo lo demás, con el mismo minuto de margen. Primero la purga y después
  // la retención: lo que la retención borra hoy queda encolado para la purga de dentro
  // de la gracia. Si una falla, la otra corre.
  let purga: ResultadoPurga | null = null;
  let retencion: ResultadoRetencion | null = null;
  if (ventanaDiaria(new Date()) && Date.now() < hasta - 60_000) {
    let cupoDelDia = false;
    try {
      const cupo = await rateLimit(claveDeCupo("purga-y-retencion"), RATE_LIMIT_CONFIGS.PURGA_Y_RETENCION);
      cupoDelDia = cupo.allowed;
    } catch (err) {
      // Ante la duda no se borra: lo que hoy no entra, entra mañana.
      logger.error({ code: errorCode(err) }, "cron_reap_stuck.cupo_de_borrado_fallo");
    }
    if (cupoDelDia) {
      try {
        const purgas = (await porBase((db) => purgarAdjuntos({ hasta: hasta - 60_000 }, db), hasta - 60_000)).filter(
          (r): r is ResultadoPurga => r !== null
        );
        purga = juntar(purgas, (a, b) => ({
          ...a,
          candidatos: a.candidatos + b.candidatos,
          purgados: a.purgados + b.purgados,
          fallidos: a.fallidos + b.fallidos,
        }));
      } catch (err) {
        logger.error({ code: errorCode(err) }, "cron_reap_stuck.purga_de_adjuntos_fallo");
      }
      try {
        const retenciones = (
          await porBase((db) => aplicarRetencion({ hasta: hasta - 60_000 }, new Date(), db), hasta - 60_000)
        ).filter((r): r is ResultadoRetencion => r !== null);
        retencion = juntar(retenciones, (a, b) => ({
          ...a,
          inquilinos: a.inquilinos + b.inquilinos,
          candidatos: a.candidatos + b.candidatos,
          borrados: a.borrados + b.borrados,
        }));
      } catch (err) {
        logger.error({ code: errorCode(err) }, "cron_reap_stuck.retencion_fallo");
      }
    }
  }

  // Third sweep, same reason: the rate limiter writes a row per key per window
  // and none of them mean anything once the window has passed.
  const { purgeExpiredRateLimits } = await import("@/lib/rate-limit/postgres");
  const purged = await purgeExpiredRateLimits();

  // Lo último, con lo que quede de la función: las dos nunca tiran y con la bandera apagada no hacen nada.
  let barridoDeBases: Record<string, number> | null = null;
  if (basePorCliente()) {
    const relanzadas = await reintentarBases(hasta - 15_000);
    const espejadas = await espejarTodas(hasta - 15_000);
    barridoDeBases = {
      ...bases,
      relanzadas: relanzadas.lanzadas,
      espejadas: espejadas.ok,
      espejo_fallas: espejadas.fallas,
    };
  }

  return NextResponse.json({
    ok: true,
    ...result,
    retomados,
    abandoned_closed: abandoned.closed,
    recordatorios_enviados: recordatorios.enviados,
    recordatorios_salteados: recordatorios.salteados,
    avisos_de_cierre: avisosDeCierre,
    desvios_nuevos: desviosNuevos,
    desvios_fallidas: desviosFallidas,
    avisos_de_desvios: avisosDeDesvios,
    purga,
    retencion,
    rate_limit_rows_purged: purged,
    ...(barridoDeBases ? { bases: barridoDeBases } : {}),
  });
}
