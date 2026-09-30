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
import { MAX_PAGINAS_PDF, normalizarMime, seMira, type Metadatos } from "@/core/adjuntos/firma";
import { esResumenSeguro } from "@/core/ai/resumen-seguro";
import type { MotivoSinLeer } from "@/core/ai/sin-leer";
import { cruzarDocumentos, type FotoCruzable, type IndicioDerivado } from "@/core/case/contradicciones";
import { MecanicaSchema, tieneMecanica, type Mecanica } from "@/core/case/mecanica";
import { esCartaDeReclamo, esDocumentoMedico } from "@/core/case/reclamo-tercero";
import { clavesQueSatisfacen } from "@/core/case/required-fields";
import { claimAttachments } from "@/lib/db/schema";
import type { AdjuntoLeido, DocumentoLeido } from "@/lib/schemas/extracted-claim";
import { contarTokens, type InlineMedia } from "@/server/ai/gemini-extractor";
import type { PolicyMatch } from "@/server/matching/policy-matcher";
import { readAttachment } from "@/server/storage/claim-attachments-bucket";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";

/**
 * Lo que se guarda en `claim_attachments.datos`: lo que dice el documento, más
 * la mecánica de un parte o una denuncia (B18) y la carta de un tercero ya leída
 * (B24), o por qué no hay forma de leerla. Sólo el equipo lo ve.
 */
export type DatosDeAdjunto = DocumentoLeido & {
  mecanica?: Mecanica | null;
  reclamo?: unknown;
  sin_leer?: MotivoSinLeer;
};

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
  datos: DatosDeAdjunto | null;
  metadatos: Metadatos | null;
}

const MAX_ARCHIVOS = 4;
export const MAX_BYTES = 8 * 1024 * 1024;
/** Un plazo agotado puede ser Vertex colgado; dos ya son el archivo. */
const MAX_PLAZOS_AGOTADOS = 2;
const ESPERA_TRAS_PLAZO_MS = 60 * 60 * 1000;
/** Gemini cobra 258 tokens por página de PDF y nada por su texto (medido en Vertex el 28/09). */
export const TOPE_TOKENS_PDF = MAX_PAGINAS_PDF * 258;
export const PLAZO_DE_CONTEO_MS = 8_000;

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
 * Lo que el modelo leyó de cada archivo que vio, por contenido. Un `indice` que
 * no es de ningún archivo enviado no se cuenta, y si repite, vale el primero.
 */
export function lecturasPorHash(vistos: ParaElModelo, lecturas: AdjuntoLeido[]): Map<string, AdjuntoLeido> {
  const salida = new Map<string, AdjuntoLeido>();
  for (const l of lecturas) {
    const hash = vistos.hashes[l.indice - 1];
    if (hash !== undefined && !salida.has(hash)) salida.set(hash, l);
  }
  return salida;
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
export async function paraElModelo(
  adjuntos: AdjuntoDelCaso[],
  caseId: string,
  tenantCtx: TenantContext
): Promise<ParaElModelo> {
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
  // El tope de páginas de la subida lee la estructura del PDF, y un PDF puede
  // esconder páginas de maneras que ningún contador propio ve. Decide lo que
  // el modelo cobraría por leerlo. Un conteo que no llega no manda el PDF; uno
  // que agota el plazo o que el modelo rechaza lo marca, así no le come el
  // tiempo ni el lugar a cada corrida.
  const cuentas = await Promise.all(
    salida.media.map((m) => (m.mimeType === "application/pdf" ? contarTokens(m, PLAZO_DE_CONTEO_MS) : 0))
  );
  const estado = cuentas.map((c) => (typeof c !== "number" ? c : c > TOPE_TOKENS_PDF ? "too_many_pages" : "va"));
  const con = (e: string) => salida.hashes.filter((_, i) => estado[i] === e);
  await marcarPlazoAgotado(caseId, tenantCtx, con("plazo"));
  const descartes: [string, string[]][] = [["too_many_pages", con("too_many_pages")], ["pages_unknown", con("rechazo")]];
  for (const [motivo, hashes] of descartes) {
    await marcarArchivos(caseId, tenantCtx, hashes, "email_worker.pdf_descartado", (db) =>
      consultaDescarte(db, caseId, hashes, motivo)
    );
  }
  const va = (_: unknown, i: number) => estado[i] === "va";
  return { hashes: salida.hashes.filter(va), media: salida.media.filter(va) };
}

/**
 * Lo que el modelo leyó de cada archivo que vio, en una sola ida a la base.
 * Un archivo sin lectura queda con resumen vacío y no null: ya se leyó y no
 * vuelve al modelo. Si falla, se registra y la extracción sigue: los archivos
 * vuelven a ir en la próxima corrida. Dice si quedó anotado.
 */
export async function anotarLecturas(
  caseId: string,
  tenantCtx: TenantContext,
  vistos: ParaElModelo,
  lecturas: AdjuntoLeido[]
): Promise<boolean> {
  if (vistos.hashes.length === 0) return true;
  const leidas = lecturasPorHash(vistos, lecturas);
  try {
    await enTenantVarias(tenantCtx, (db) =>
      vistos.hashes.map((hash) => {
        const leido = leidas.get(hash);
        return db
          .update(claimAttachments)
          .set({
            resumen: leido && esResumenSeguro(leido.resumen, [], 200) ? leido.resumen : "",
            util: leido?.util ?? null,
            datos: leido?.documento
              ? { ...leido.documento, ...(tieneMecanica(leido.mecanica) ? { mecanica: leido.mecanica } : {}) }
              : null,
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
    return true;
  } catch (err) {
    logger.error({ case_id: caseId, code: errorCode(err) }, "email_worker.lecturas_error");
    return false;
  }
}

/** Suma un plazo agotado a cada archivo. Ver `esperaPorPlazo`. */
function consultaDescarte(db: ClienteDatos, caseId: string, hashes: string[], motivo: string) {
  return db
    .update(claimAttachments)
    .set({ metadatos: { descarte: motivo } })
    .where(and(eq(claimAttachments.case_id, caseId), inArray(claimAttachments.content_hash, hashes)));
}

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

async function marcarArchivos(
  caseId: string,
  tenantCtx: TenantContext,
  hashes: string[],
  evento: string,
  consulta: Parameters<typeof enTenant>[1]
): Promise<void> {
  if (hashes.length === 0) return;
  logger.warn({ case_id: caseId, archivos: hashes.length }, evento);
  try {
    await enTenant(tenantCtx, consulta);
  } catch (err) {
    logger.error({ case_id: caseId, code: errorCode(err) }, `${evento}_error`);
  }
}

/** La extracción con estos archivos agotó el plazo: el reintento va sin ellos. */
export function marcarPlazoAgotado(caseId: string, tenantCtx: TenantContext, hashes: string[]): Promise<void> {
  return marcarArchivos(caseId, tenantCtx, hashes, "email_worker.plazo_agotado", (db) =>
    consultaPlazoAgotado(db, caseId, hashes)
  );
}

/**
 * Las cartas de un tercero que todavía nadie leyó a fondo (B24), una por
 * contenido: el mismo archivo mandado dos veces es una carta. Las que ya se sabe
 * que no se pueden leer no vuelven.
 *
 * Son las que el modelo reconoció al leer los archivos del caso y, si se pasa
 * `deMensaje`, los archivos sin leer de ese mensaje: llegó a un caso que el
 * agente ya no lee, y sin la extracción nadie reconoció si alguno es una carta.
 */
export function cartasPendientes(adjuntos: AdjuntoDelCaso[], deMensaje?: string): AdjuntoDelCaso[] {
  const hashes = new Set<string>();
  // Un duplicado que llegó después no se reconoce de nuevo: su gemelo ya se leyó.
  const yaLeidos = new Set(adjuntos.filter((a) => (a.datos || a.resumen !== null) && a.content_hash).map((a) => a.content_hash!));
  return adjuntos.filter((a) => {
    const { datos } = a;
    if (a.rejected_reason !== null || a.storage_path === null) return false;
    const sinReconocer =
      !datos &&
      deMensaje !== undefined &&
      a.claim_message_id === deMensaje &&
      a.resumen === null &&
      !(a.content_hash && yaLeidos.has(a.content_hash)) &&
      seMira(a.content_type) &&
      !!a.metadatos?.firma;
    const reconocida = !!datos && esCartaDeReclamo(datos.tipo) && datos.reclamo === undefined && !datos.sin_leer;
    if (!sinReconocer && !reconocida) return false;
    if (a.content_hash) {
      if (hashes.has(a.content_hash)) return false;
      hashes.add(a.content_hash);
    }
    return true;
  });
}

/**
 * Las filas del caso con lo que esta corrida leyó de los archivos que todavía
 * no tenían lectura: la fila de la base es la de antes de anotarla.
 */
export function conLecturasDeEstaCorrida(
  adjuntos: AdjuntoDelCaso[],
  vistos: ParaElModelo,
  lecturas: AdjuntoLeido[]
): AdjuntoDelCaso[] {
  const leidas = lecturasPorHash(vistos, lecturas);
  return adjuntos.map((a) => {
    const documento = a.content_hash ? leidas.get(a.content_hash)?.documento : null;
    return documento ? { ...a, datos: documento } : a;
  });
}

/** La mecánica que cuentan los partes y denuncias del caso, los leídos antes y los de esta corrida (B18). */
export function mecanicasDeAdjuntos(adjuntos: AdjuntoDelCaso[], vistos: ParaElModelo, lecturas: AdjuntoLeido[]): Mecanica[] {
  const deEstaCorrida = [...lecturasPorHash(vistos, lecturas).values()].filter((l) => l.documento);
  const atajar = MecanicaSchema.nullable().catch(null);
  return [...adjuntos.map((a) => a.datos?.mecanica), ...deEstaCorrida.map((l) => l.mecanica)]
    .map((m) => atajar.parse(m))
    .filter(tieneMecanica);
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
  const leidas = lecturasPorHash(vistos, lecturas);
  const deEstaCorrida = [...leidas.values()];
  const leidos = [...adjuntos.map((a) => a.datos), ...deEstaCorrida.map((l) => l.documento)].filter(
    (d): d is DocumentoLeido => !!d
  );
  // La carta de un tercero, y la documentación médica que la acompaña, son de
  // quien reclama: sus nombres y patentes no se cotejan contra el asegurado.
  const hayCarta = leidos.some((d) => esCartaDeReclamo(d.tipo));
  const documentos = leidos.filter((d) => !esCartaDeReclamo(d.tipo) && !(hayCarta && esDocumentoMedico(d.tipo)));
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
