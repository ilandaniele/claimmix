/**
 * Los archivos del caso que el worker le muestra al modelo.
 *
 * Una sola consulta trae todos los adjuntos del caso: de ahí salen las notas
 * de voz a transcribir, las fotos y PDF que todavía nadie leyó, y lo que ya se
 * leyó antes para cruzar contra el reclamo.
 */

import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { enTenant, enTenantVarias, type ClienteDatos, type TenantContext } from "@/data/scope";
import { normalizarMime, seMira, type Metadatos } from "@/core/adjuntos/firma";
import { esResumenSeguro } from "@/core/ai/resumen-seguro";
import { cruzarDocumentos, type FotoCruzable, type IndicioDerivado } from "@/core/case/contradicciones";
import { clavesQueSatisfacen } from "@/core/case/required-fields";
import { claimAttachments } from "@/lib/db/schema";
import type { AdjuntoLeido, DocumentoLeido } from "@/lib/schemas/extracted-claim";
import type { InlineMedia } from "@/server/ai/gemini-extractor";
import type { PolicyMatch } from "@/server/matching/policy-matcher";
import { readAttachment } from "@/server/storage/claim-attachments-bucket";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

export interface AdjuntoDelCaso {
  id: string;
  claim_message_id: string | null;
  content_type: string;
  storage_path: string | null;
  content_hash: string | null;
  size_bytes: number;
  resumen: string | null;
  util: boolean | null;
  rejected_reason: string | null;
  datos: DocumentoLeido | null;
  metadatos: Metadatos | null;
}

const MAX_ARCHIVOS = 4;
const MAX_BYTES = 8 * 1024 * 1024;
/** Un plazo agotado puede ser Vertex colgado; dos ya son el archivo. */
const MAX_PLAZOS_AGOTADOS = 2;
const ESPERA_TRAS_PLAZO_MS = 60 * 60 * 1000;

/** La consulta sola, para ir en el lote del prompt. Ver `cargarLoDelPrompt`. */
export function consultaAdjuntos(db: ClienteDatos, caseId: string) {
  return db
    .select({
      id: claimAttachments.id,
      claim_message_id: claimAttachments.claim_message_id,
      content_type: claimAttachments.content_type,
      storage_path: claimAttachments.storage_path,
      content_hash: claimAttachments.content_hash,
      size_bytes: claimAttachments.size_bytes,
      resumen: claimAttachments.resumen,
      util: claimAttachments.util,
      rejected_reason: claimAttachments.rejected_reason,
      datos: claimAttachments.datos,
      metadatos: claimAttachments.metadatos,
    })
    .from(claimAttachments)
    .where(eq(claimAttachments.case_id, caseId))
    .orderBy(asc(claimAttachments.created_at));
}

export const deAdjuntos = (filas: unknown): AdjuntoDelCaso[] =>
  Array.isArray(filas) ? (filas as AdjuntoDelCaso[]) : [];

/**
 * Todos los adjuntos del caso, del más viejo al más nuevo. Vacío si la lectura
 * falla: sin archivos la extracción sigue siendo la de siempre.
 */
export async function adjuntosDelCaso(caseId: string, tenantCtx: TenantContext): Promise<AdjuntoDelCaso[]> {
  try {
    return deAdjuntos(await enTenant(tenantCtx, (db) => consultaAdjuntos(db, caseId)));
  } catch (err) {
    logger.error({ case_id: caseId, code: errorCode(err) }, "email_worker.adjuntos_error");
    return [];
  }
}

export interface ParaElModelo {
  /** Uno por archivo, en el orden de `media`: el `indice` que devuelve el modelo es la posición + 1. */
  hashes: string[];
  media: InlineMedia[];
}

/**
 * ¿El archivo espera por plazos agotados? Después del primero espera una hora,
 * así el reintento sale sin él; después del segundo no vuelve a ir.
 */
export function esperaPorPlazo(metadatos: Metadatos | null, ahora = Date.now()): boolean {
  const p = metadatos?.plazoAgotado;
  return !!p && (p.veces >= MAX_PLAZOS_AGOTADOS || ahora - Date.parse(p.en) < ESPERA_TRAS_PLAZO_MS);
}

/**
 * Las fotos y PDF que el modelo todavía no leyó, uno por contenido, hasta
 * cuatro y ocho megas. Se leen de R2 acá, antes de las guardas de tiempo, para
 * que el plazo cuente también la descarga.
 */
export async function paraElModelo(adjuntos: AdjuntoDelCaso[]): Promise<ParaElModelo> {
  const salida: ParaElModelo = { hashes: [], media: [] };
  // Un duplicado que llegó después no vuelve al modelo: su gemelo ya se leyó.
  const vistos = new Set(adjuntos.filter((a) => a.resumen !== null && a.content_hash).map((a) => a.content_hash!));
  let bytes = 0;
  for (const a of adjuntos) {
    if (salida.media.length >= MAX_ARCHIVOS) break;
    const hash = a.content_hash;
    if (
      !hash ||
      !a.storage_path ||
      vistos.has(hash) ||
      a.rejected_reason !== null ||
      !seMira(a.content_type) ||
      !a.metadatos?.firma ||
      esperaPorPlazo(a.metadatos) ||
      bytes + a.size_bytes > MAX_BYTES
    ) {
      continue;
    }
    vistos.add(hash);
    const leido = await readAttachment(a.storage_path);
    if (!leido) continue;
    bytes += leido.length;
    salida.hashes.push(hash);
    salida.media.push({ mimeType: normalizarMime(a.content_type), data: leido.toString("base64") });
  }
  return salida;
}

/**
 * Lo que el modelo leyó de cada archivo que vio, en una sola ida a la base.
 * Un archivo sin lectura queda con resumen vacío y no null: ya se leyó y no
 * vuelve al modelo. Si falla, se registra y la extracción sigue: los archivos
 * vuelven a ir en la próxima corrida.
 */
export async function anotarLecturas(
  caseId: string,
  tenantCtx: TenantContext,
  vistos: ParaElModelo,
  lecturas: AdjuntoLeido[]
): Promise<void> {
  if (vistos.hashes.length === 0) return;
  try {
    await enTenantVarias(tenantCtx, (db) =>
      vistos.hashes.map((hash, i) => {
        const leido = lecturas.find((l) => l.indice === i + 1);
        return db
          .update(claimAttachments)
          .set({
            resumen: leido && esResumenSeguro(leido.resumen, [], 200) ? leido.resumen : "",
            util: leido?.util ?? null,
            datos: leido?.documento ?? null,
          })
          .where(
            and(
              eq(claimAttachments.case_id, caseId),
              eq(claimAttachments.content_hash, hash),
              isNull(claimAttachments.resumen)
            )
          );
      })
    );
  } catch (err) {
    logger.error({ case_id: caseId, code: errorCode(err) }, "email_worker.lecturas_error");
  }
}

/** Suma un plazo agotado a cada archivo. Ver `esperaPorPlazo`. */
export function consultaPlazoAgotado(db: ClienteDatos, caseId: string, hashes: string[]) {
  const m = claimAttachments.metadatos;
  return db
    .update(claimAttachments)
    .set({
      metadatos: sql`coalesce(${m}, '{}'::jsonb) || jsonb_build_object('plazoAgotado', jsonb_build_object(
        'veces', coalesce((${m}->'plazoAgotado'->>'veces')::int, 0) + 1,
        'en', ${new Date().toISOString()}::text))`,
    })
    .where(and(eq(claimAttachments.case_id, caseId), inArray(claimAttachments.content_hash, hashes)));
}

/** La extracción con estos archivos agotó el plazo: el reintento va sin ellos. */
export async function marcarPlazoAgotado(caseId: string, tenantCtx: TenantContext, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  logger.warn({ case_id: caseId, archivos: hashes.length }, "email_worker.plazo_agotado");
  try {
    await enTenant(tenantCtx, (db) => consultaPlazoAgotado(db, caseId, hashes));
  } catch (err) {
    logger.error({ case_id: caseId, code: errorCode(err) }, "email_worker.plazo_agotado_error");
  }
}

/**
 * Los documentos del caso —los leídos antes y los de esta corrida— y las fotos
 * con fecha o GPS, cruzados contra el reclamo y la primera póliza encontrada.
 *
 * De las fotos cuentan sólo las que el modelo leyó como útiles y no como un
 * documento: la fecha de la foto de un DNI o de un registro es la de la foto,
 * no la del siniestro.
 */
export function indiciosDeAdjuntos(entrada: {
  adjuntos: AdjuntoDelCaso[];
  vistos: ParaElModelo;
  lecturas: AdjuntoLeido[];
  campos: Record<string, string | undefined>;
  poliza: PolicyMatch | undefined;
  ahora: Date;
}): IndicioDerivado[] {
  const { adjuntos, vistos, lecturas, campos, poliza, ahora } = entrada;
  const deEstaCorrida = lecturas.filter((l) => l.indice >= 1 && l.indice <= vistos.hashes.length);
  const leidas = new Map(deEstaCorrida.map((l) => [vistos.hashes[l.indice - 1]!, l]));
  const documentos = [...adjuntos.map((a) => a.datos), ...deEstaCorrida.map((l) => l.documento)].filter(
    (d): d is DocumentoLeido => !!d
  );
  const fotos: FotoCruzable[] = adjuntos
    .filter((a) => {
      if (a.rejected_reason !== null || !a.metadatos) return false;
      const leida = a.content_hash ? leidas.get(a.content_hash) : undefined;
      const lectura = leida ?? (a.resumen !== null ? { util: a.util, documento: a.datos } : null);
      return lectura?.util === true && lectura.documento === null;
    })
    .map(({ metadatos: m }) => ({ tomadaEn: m!.tomadaEn, lat: m!.lat, lon: m!.lon }))
    .filter((f) => f.tomadaEn || (f.lat !== undefined && f.lon !== undefined));
  if (documentos.length === 0 && fotos.length === 0) return [];
  const valores = (clave: string) => clavesQueSatisfacen(clave).map((k) => campos[k]);
  return cruzarDocumentos({
    documentos,
    fotos,
    reclamo: {
      fecha: campos.accident_date ?? campos.incident_date ?? null,
      provincia: valores("provincia_siniestro").find(Boolean) ?? null,
      patentes: [...valores("patente_vehiculo"), campos.party_b_plate].filter((p): p is string => !!p),
      dni: campos.dni ?? null,
      nombre: campos.full_name ?? null,
    },
    poliza: poliza ? { patentes: poliza.plates, dni: poliza.customerDni, titular: poliza.customerName || null } : null,
    ahora,
  });
}
