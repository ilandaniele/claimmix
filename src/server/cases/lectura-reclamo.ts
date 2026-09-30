/**
 * La lectura de la carta con que un tercero reclama al asegurado (B24).
 *
 * La corrida del worker la pide cuando el modelo reconoció una carta entre los
 * adjuntos, y la de un mensaje que llegó a un caso que el agente ya no lee
 * (`atenderCartasDeUnTardio`) para los archivos de ese mensaje: una lectura
 * aparte, con el mismo presupuesto de IA, su propio tope por caso y el consumo
 * anotado. Una sola corrida a la vez lee cada carta. El resultado
 * queda en `claim_attachments.datos.reclamo`, sólo para el equipo, y nunca toca
 * `cases`: ni la respuesta al asegurado ni su estado dependen de esto. Sin
 * cupo, sin presupuesto o sin respuesta del modelo no se escribe nada y la
 * ficha dice «sin leer». Lo que ningún reintento arregla (el archivo, una
 * respuesta que no se puede usar) queda anotado en `datos.sin_leer`: no vuelve
 * a gastar una lectura ni le tapa el lugar a las otras cartas.
 */

import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { normalizarMime, seMira } from "@/core/adjuntos/firma";
import { PLAZO_DEL_MODELO_MS } from "@/core/ai/plazo-del-modelo";
import { esDefinitivo, type MotivoSinLeer } from "@/core/ai/sin-leer";
import {
  CARTA_DE_RECLAMO,
  limpiarReclamo,
  PROMPT_DEL_RECLAMO,
  ReclamoTerceroSchema,
  type ReclamoTercero,
} from "@/core/case/reclamo-tercero";
import { enTenant } from "@/data/scope";
import { claimAttachments, claimMessages } from "@/lib/db/schema";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import type { DocumentoLeido } from "@/lib/schemas/extracted-claim";
import type { InlineMedia } from "@/server/ai/gemini-extractor";
import { leerDocumento, type Lectura } from "@/server/ai/leer-documento";
import { readAttachment } from "@/server/storage/claim-attachments-bucket";
import {
  adjuntosDelCaso,
  cartasPendientes,
  MAX_BYTES,
  type AdjuntoDelCaso,
  type ParaElModelo,
} from "@/server/worker/adjuntos";

/**
 * Lo que tiene que quedarle a la invocación para empezar una lectura: el conteo
 * de páginas y el modelo, que son hasta tres plazos. Con menos, la matan a
 * mitad y la carta vuelve en la próxima corrida.
 */
export const MINIMO_PARA_LEER_CARTA_MS = 3 * PLAZO_DEL_MODELO_MS;

/**
 * Cuánto tiene una corrida la lectura de una carta antes de que otra pueda
 * tomarla: lo que tarda una lectura, con margen. Si la corrida murió, la carta
 * vuelve pasado este plazo.
 */
const RESERVA_DE_LECTURA_MS = 2 * MINIMO_PARA_LEER_CARTA_MS;

const SIN_VISTOS: ParaElModelo = { hashes: [], media: [] };

/** Lo que dice de sí un archivo que nadie leyó antes: nada. */
const DOCUMENTO_VACIO: DocumentoLeido = {
  tipo: null,
  fecha: null,
  patente: null,
  dni: null,
  nombre: null,
  lugar: null,
  provincia: null,
};

/** Una carta al modelo, sola y como archivo: nada de lo que dice entra en el prompt. */
function leerCarta(tenantId: string, caseId: string, media: InlineMedia): Promise<Lectura<ReclamoTercero>> {
  return leerDocumento({
    tenantId,
    userId: null,
    ambito: "lectura-reclamo",
    partesDeClave: [tenantId, caseId],
    ...PROMPT_DEL_RECLAMO,
    media: [media],
    schema: ReclamoTerceroSchema,
    limpiar: limpiarReclamo,
  });
}

/**
 * Toma la lectura de esta carta para esta corrida, y dice si la obtuvo. La toma
 * la base y no un contador: dos corridas que llegan juntas —un re-despacho, dos
 * mensajes seguidos— no leen dos veces (ni gastan dos veces del tope) la misma
 * carta. Sólo una la obtiene; la otra la deja. Si la dueña murió, la retoma
 * quien llegue pasada la reserva.
 */
async function reservarCarta(tenantId: string, carta: Pick<AdjuntoDelCaso, "id">): Promise<boolean> {
  const metadatos = claimAttachments.metadatos;
  const tomada = await enTenant({ tenantId }, (db) =>
    db
      .update(claimAttachments)
      .set({ metadatos: sql`coalesce(${metadatos}, '{}'::jsonb) || jsonb_build_object('leyendoCarta', now())` })
      .where(
        and(
          eq(claimAttachments.id, carta.id),
          sql`(${metadatos}->>'leyendoCarta' is null
            or (${metadatos}->>'leyendoCarta')::timestamptz < now() - interval '${sql.raw(String(RESERVA_DE_LECTURA_MS))} milliseconds')`
        )
      )
      .returning({ id: claimAttachments.id })
  );
  return tomada.length > 0;
}

/**
 * Deja la lectura, o por qué no hay forma de leerla, junto a lo que ya decía el
 * documento. Sólo escribe en los archivos de esa carta —el mismo caso, el mismo
 * contenido— y en ningún otro lado. Por contenido y no por fila: el mismo
 * archivo mandado dos veces son dos filas y una sola carta.
 *
 * Un archivo que nadie había leído (llegó a un caso que el agente ya no lee)
 * queda con la lectura como único dato: `es_reclamo` decide si se lo reconoce
 * como carta, y si no lo es queda anotado que se miró.
 */
async function anotarEnCarta(
  tenantId: string,
  caseId: string,
  carta: Pick<AdjuntoDelCaso, "id" | "content_hash">,
  anotacion: { reclamo: ReclamoTercero } | { sin_leer: MotivoSinLeer }
): Promise<void> {
  const esCarta = "reclamo" in anotacion && anotacion.reclamo.es_reclamo;
  const base = { ...DOCUMENTO_VACIO, tipo: esCarta ? CARTA_DE_RECLAMO : null };
  await enTenant({ tenantId }, (db) =>
    db
      .update(claimAttachments)
      .set({
        datos: sql`coalesce(${claimAttachments.datos}, ${JSON.stringify(base)}::jsonb) || ${JSON.stringify(anotacion)}::jsonb`,
      })
      .where(
        and(
          eq(claimAttachments.case_id, caseId),
          carta.content_hash ? eq(claimAttachments.content_hash, carta.content_hash) : eq(claimAttachments.id, carta.id)
        )
      )
  );
}

/**
 * El archivo de la carta: el que ya se le mostró al modelo en esta corrida, o el
 * del almacenamiento. `null` si no se pudo bajar: se prueba en otra corrida.
 */
async function mediaDe(carta: AdjuntoDelCaso, vistos: ParaElModelo): Promise<Lectura<InlineMedia> | null> {
  const i = carta.content_hash ? vistos.hashes.indexOf(carta.content_hash) : -1;
  if (i >= 0 && vistos.media[i]) return { ok: vistos.media[i]! };
  if (!carta.storage_path || !seMira(carta.content_type)) return { sinLeer: "archivo" };
  const bytes = await readAttachment(carta.storage_path);
  if (!bytes) return null;
  if (bytes.length > MAX_BYTES) return { sinLeer: "archivo" };
  return { ok: { mimeType: normalizarMime(carta.content_type), data: bytes.toString("base64") } };
}

/**
 * Lee las cartas pendientes del caso mientras a la invocación (`hasta`, en
 * epoch ms) le quede aire. Nunca tira: una falla acá no puede costarle al
 * asegurado su respuesta ni al caso su estado.
 *
 * Una carta que no se puede leer nunca se anota y sigue la próxima. Una que
 * falla por algo pasajero se prueba en otra corrida, dentro del tope; si lo que
 * falta es de todo el caso (cupo, presupuesto, modo de prueba) se corta acá.
 * Una que otra corrida está leyendo se deja: no se lee dos veces.
 */
export async function atenderCartas({
  tenantId,
  caseId,
  adjuntos,
  vistos = SIN_VISTOS,
  deMensaje,
  hasta,
}: {
  tenantId: string;
  caseId: string;
  adjuntos: AdjuntoDelCaso[];
  vistos?: ParaElModelo;
  /** El mensaje que llegó a un caso que el agente ya no lee: sus archivos se reconocen acá. Ver `cartasPendientes`. */
  deMensaje?: string;
  hasta: number;
}): Promise<void> {
  for (const carta of cartasPendientes(adjuntos, deMensaje)) {
    if (hasta - Date.now() < MINIMO_PARA_LEER_CARTA_MS) return;
    try {
      const archivo = await mediaDe(carta, vistos);
      if (!archivo) continue;
      if ("ok" in archivo && !(await reservarCarta(tenantId, carta))) continue;
      const lectura = "ok" in archivo ? await leerCarta(tenantId, caseId, archivo.ok) : archivo;
      if ("ok" in lectura) {
        await anotarEnCarta(tenantId, caseId, carta, { reclamo: lectura.ok });
        continue;
      }
      logger.info({ case_id: caseId, motivo: lectura.sinLeer }, "lectura_reclamo.sin_leer");
      if (esDefinitivo(lectura.sinLeer)) {
        await anotarEnCarta(tenantId, caseId, carta, { sin_leer: lectura.sinLeer });
      } else if (lectura.sinLeer !== "modelo") {
        return;
      }
    } catch (err) {
      logger.warn({ case_id: caseId, error_code: errorCode(err) }, "lectura_reclamo.error");
    }
  }
}

/**
 * Las cartas de un caso al que llegó un mensaje que el agente ya no lee: las que
 * una corrida anterior reconoció y no llegó a leer, y los archivos del último
 * mensaje, que nadie miró. Sólo se guarda para el equipo: el asegurado no
 * recibe nada. Nunca tira.
 */
export async function atenderCartasDeUnTardio({
  tenantId,
  caseId,
  hasta,
}: {
  tenantId: string;
  caseId: string;
  hasta: number;
}): Promise<void> {
  try {
    const [ultimo] = await enTenant({ tenantId }, (db) =>
      db
        .select({ id: claimMessages.id })
        .from(claimMessages)
        .where(and(eq(claimMessages.case_id, caseId), eq(claimMessages.direction, "inbound")))
        .orderBy(desc(claimMessages.received_at))
        .limit(1)
    );
    await atenderCartas({
      tenantId,
      caseId,
      adjuntos: await adjuntosDelCaso(caseId, { tenantId }),
      deMensaje: ultimo?.id,
      hasta,
    });
  } catch (err) {
    logger.warn({ case_id: caseId, error_code: errorCode(err) }, "lectura_reclamo.error");
  }
}
