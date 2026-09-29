/**
 * Todo lo que la pantalla de detalle necesita para pintar un caso.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────
 *
 * Abrir un caso costaba hasta once viajes a la base, y —lo que se paga de
 * verdad— CINCO esperas encadenadas: la fila del caso, después tres
 * relacionadas, después dos de correo, después el respaldo del parser, y
 * después el acordeón, que era otro componente de servidor que consultaba solo.
 * Cada tanda esperaba a que terminara la anterior aunque no necesitara nada de
 * ella.
 *
 * Ahora son dos: la fila del caso —que hace falta antes de cualquier cosa,
 * porque si no existe hay que devolver 404 y porque su canal decide qué más
 * pedir— y después TODO lo demás junto.
 *
 * ── Por qué no es un solo `enTenantVarias` ──────────────────────────────────
 *
 * Porque un lote es UNA transacción. Hoy cada consulta degrada por su cuenta:
 * si falla el historial de auditoría, la pantalla abre igual y muestra el
 * resto. Con un lote, un hipo leyendo la auditoría se llevaría puestos los
 * campos extraídos, la documentación faltante, las confirmaciones, los adjuntos
 * y el acordeón, todos juntos — y encima el respaldo del parser cambiaría de
 * resultado, porque hoy la regex rellena la tabla cuando la consulta de campos
 * falla, y con un catch afuera recibiría texto vacío.
 *
 * `Promise.all` sobre promesas con su propio `.catch` da la concurrencia sin la
 * transacción: mismo ahorro de esperas, mismos dominios de falla.
 * `tests/unit/cases-get.test.ts` y `tests/unit/case-detail-view.test.ts` lo
 * fijan, así que si alguien las junta se pone rojo y explica por qué.
 */

import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { esMotivoSinLeer, type MotivoSinLeer } from "@/core/ai/sin-leer";
import { evaluarCobertura, type PolizaParaCobertura, type ResultadoDeCobertura } from "@/core/case/cobertura";
import { dia } from "@/core/case/contradicciones";
import type { MontoEstimado } from "@/core/case/monto-estimado";
import { esCandidatoAPresupuesto, type LecturaGuardada } from "@/core/case/presupuesto-taller";
import {
  cruzarConHistoria,
  esCartaDeReclamo,
  faltantesDelReclamo,
  ReclamoTerceroSchema,
  totalDelReclamo,
  type Cruce,
  type DocumentoDelCaso,
  type ReclamoTercero,
} from "@/core/case/reclamo-tercero";
import { esChoque, leerResponsabilidad, type Responsabilidad } from "@/core/case/responsabilidad";
import { clavesQueSatisfacen } from "@/core/case/required-fields";
import { enTenant, type TenantContext } from "@/data/scope";
import { claimAttachments, claimFieldConfirmations, policies, users } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import type { CaseRow, ExtractedFieldRow, MissingDocRow } from "@/lib/db/types";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import {
  fetchAuditLog,
  fetchCaseRow,
  fetchExtractedFields,
  fetchMissingDocs,
  type AuditLogEntry,
} from "@/server/cases/get";
import {
  mensajesEntrantes,
  ultimoMensajeEntrante,
  type MensajeEntrante,
} from "@/server/cases/inbound-messages";
import { patentesDe } from "@/server/matching/policy-matcher";

/** Cuántos mensajes muestra el acordeón del original. */
const MENSAJES_A_MOSTRAR = 5;

export interface ConfirmacionEnPantalla {
  id: string;
  field_key: string;
  proposed_value: string | null;
  conflict_with_value: string | null;
  confidence: number;
  status: "pending" | "confirmed" | "rejected" | "corrected";
  resolved_at: string | null;
}

export interface AdjuntoEnPantalla {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  external_url: string;
  uploaded_at: string | null;
  /**
   * Por qué el archivo no quedó guardado, o `null` si quedó.
   *
   * Sin esto la fila rechazada —la que se escribe justamente para avisar que
   * mandaron algo y no entró— llegaba a la pantalla idéntica a una guardada.
   */
  rejected_reason: string | null;
  /**
   * Si tiene bytes guardados y se puede abrir desde el caso.
   *
   * `storage_path` nunca sale de acá: la pantalla no necesita la ruta del
   * bucket, sólo si hay algo detrás para pedirle a la ruta que lo sirve.
   */
  disponible: boolean;
  /** Qué documento pedido cerró este adjunto, o `null` si no cerró ninguno. */
  matched_doc_key: string | null;
  /** Una línea de la IA sobre qué es el archivo, o `null` si todavía no lo leyó. */
  resumen: string | null;
  /** `false` si la IA lo dio por ajeno al reclamo; `null` si no opinó. */
  util: boolean | null;
  /**
   * Mismo contenido que un adjunto anterior del caso. El hash no sale de acá:
   * la pantalla sólo necesita saber que se repite.
   */
  duplicado: boolean;
  /** Si vale la pena ofrecer leerlo como presupuesto del taller (B21). */
  esPresupuesto: boolean;
  /** Lo leído del presupuesto, o `null` si nadie lo pidió o no se pudo leer. */
  lectura_presupuesto: LecturaGuardada | null;
}

/** La cobertura y el monto del caso, sólo para el equipo (B6, B23). */
export interface CoberturaEnPantalla {
  resultado: ResultadoDeCobertura;
  /** `sin_leer`: el PDF se subió y el modelo no lo leyó; el veredicto sale sin coberturas. */
  condiciones: "sin_poliza" | "sin_subir" | "sin_leer" | "leidas";
  monto: MontoEstimado | null;
}

/** La carta con que un tercero reclama al asegurado, leída para el equipo (B24). */
export interface CartaEnPantalla {
  id: string;
  filename: string;
  /** `null`: se la reconoció como carta y todavía no se leyó. */
  reclamo: ReclamoTercero | null;
  /** Sin lectura: por qué no hay forma de leerla, o `null` si se va a reintentar. */
  sinLeer: MotivoSinLeer | null;
  /** Claves de lo que la carta no trae; se traducen en la pantalla. */
  faltantes: string[];
  cruces: Cruce[];
  total: number | null;
}

export interface DetalleDeCaso {
  case: CaseRow;
  extracted_fields: ExtractedFieldRow[];
  missing_docs: MissingDocRow[];
  audit_log: AuditLogEntry[];
  confirmations: ConfirmacionEnPantalla[];
  attachments: AdjuntoEnPantalla[];
  /** Los primeros mensajes del asegurado, para el acordeón del original. */
  messages: MensajeEntrante[];
  /** `true` si `messages` puede no incluir el más nuevo — ver `ultimoParaReleer`. */
  hayMasMensajes: boolean;
  /** El nombre de quien tiene asignado el caso, o `null` si nadie o no se pudo leer. */
  asignado_nombre: string | null;
  /** `null` si la póliza no se pudo leer: mejor sin panel que con un veredicto falso. */
  cobertura: CoberturaEnPantalla | null;
  /** La opinión orientativa de responsabilidad (B18), o `null` si no hay o no tiene la forma. */
  responsabilidad: Responsabilidad | null;
  cartas: CartaEnPantalla[];
}

/**
 * En la base el estado es texto libre; en la pantalla es una de cuatro.
 *
 * Cualquier otra cosa se lee como pendiente: es lo único seguro de mostrar,
 * porque muestra el campo como todavía sin resolver en vez de darlo por bueno.
 */
function aEstadoDeConfirmacion(
  valor: string
): ConfirmacionEnPantalla["status"] {
  return valor === "confirmed" || valor === "rejected" || valor === "corrected"
    ? valor
    : "pending";
}

async function fetchConfirmaciones(
  ctx: TenantContext,
  caseId: string
): Promise<ConfirmacionEnPantalla[]> {
  try {
    const filas = await enTenant(ctx, (db) =>
      db
        .select({
          id: claimFieldConfirmations.id,
          field_key: claimFieldConfirmations.field_name,
          proposed_value: claimFieldConfirmations.suggested_value,
          conflict_with_value: claimFieldConfirmations.conflict_with_value,
          confidence: claimFieldConfirmations.confidence,
          status: claimFieldConfirmations.status,
          resolved_at: claimFieldConfirmations.confirmed_at,
        })
        .from(claimFieldConfirmations)
        .where(eq(claimFieldConfirmations.case_id, caseId))
        .orderBy(asc(claimFieldConfirmations.created_at))
    );

    // `confidence` es numeric y drizzle lo entrega como texto: se normaliza acá,
    // en el borde, y no en tres lugares distintos de la pantalla.
    return filas.map((f) => ({
      ...f,
      confidence: Number(f.confidence),
      status: aEstadoDeConfirmacion(f.status),
    }));
  } catch (err) {
    // Degrada a propósito —la pantalla no se cae porque falle una consulta—
    // pero no en silencio: sin esto, un adjunto que no se pudo leer se ve
    // igual que un caso sin adjuntos, y alguien cierra un caso creyendo que la
    // persona no mandó nada.
    logger.error({ error_code: errorCode(err) }, "cases.detail_view.query_failed");
    return [];
  }
}

interface FilaDeCarta {
  id: string;
  filename: string;
  content_type: string;
  content_hash: string | null;
  resumen: string | null;
  tipo: string | null;
  nombre: string | null;
  reclamo: unknown;
  sin_leer: string | null;
}

/** Las cartas de terceros del caso, cada una cotejada con los demás documentos que llegaron. */
function cartasDe(filas: ReadonlyArray<FilaDeCarta>): CartaEnPantalla[] {
  // La carta misma no cuenta como el presupuesto que dice adjuntar.
  const documentos: DocumentoDelCaso[] = filas.map((f) => ({
    tipo: f.tipo,
    nombre: f.nombre,
    presupuesto:
      !esCartaDeReclamo(f.tipo) &&
      esCandidatoAPresupuesto({ content_type: f.content_type, file_name: f.filename, resumen: f.resumen, datos: { tipo: f.tipo } }),
  }));
  const hashes = new Set<string>();
  return filas.flatMap((f) => {
    if (!esCartaDeReclamo(f.tipo)) return [];
    // El mismo archivo mandado dos veces es una carta y un panel.
    if (f.content_hash) {
      if (hashes.has(f.content_hash)) return [];
      hashes.add(f.content_hash);
    }
    const leido = ReclamoTerceroSchema.safeParse(f.reclamo);
    const reclamo = leido.success ? leido.data : null;
    // Leída y no era un reclamo: no hay nada que mostrar, el archivo sigue en los adjuntos.
    if (reclamo && !reclamo.es_reclamo) return [];
    return [
      {
        id: f.id,
        filename: f.filename,
        reclamo,
        sinLeer: !reclamo && esMotivoSinLeer(f.sin_leer) ? f.sin_leer : null,
        faltantes: reclamo ? faltantesDelReclamo(reclamo, documentos) : [],
        cruces: reclamo ? cruzarConHistoria(reclamo, documentos) : [],
        total: reclamo ? totalDelReclamo(reclamo) : null,
      },
    ];
  });
}

async function fetchAdjuntos(
  ctx: TenantContext,
  caseId: string
): Promise<{ adjuntos: AdjuntoEnPantalla[]; cartas: CartaEnPantalla[] }> {
  try {
    const filas = await enTenant(ctx, (db) =>
      db
        .select({
          id: claimAttachments.id,
          filename: claimAttachments.file_name,
          content_type: claimAttachments.content_type,
          size_bytes: claimAttachments.size_bytes,
          external_url: claimAttachments.external_url,
          uploaded_at: claimAttachments.created_at,
          rejected_reason: claimAttachments.rejected_reason,
          storage_path: claimAttachments.storage_path,
          matched_doc_key: claimAttachments.matched_doc_key,
          resumen: claimAttachments.resumen,
          util: claimAttachments.util,
          content_hash: claimAttachments.content_hash,
          // `datos` entero trae lo que el documento dice: sólo se trae el tipo, el nombre para cotejar y la carta.
          tipo: sql<string | null>`${claimAttachments.datos}->>'tipo'`,
          nombre: sql<string | null>`${claimAttachments.datos}->>'nombre'`,
          reclamo: sql<unknown>`${claimAttachments.datos}->'reclamo'`,
          sin_leer: sql<string | null>`${claimAttachments.datos}->>'sin_leer'`,
          descarte: sql<string | null>`${claimAttachments.metadatos}->>'descarte'`,
          lectura_presupuesto: claimAttachments.lectura_presupuesto,
        })
        .from(claimAttachments)
        .where(eq(claimAttachments.case_id, caseId))
        .orderBy(asc(claimAttachments.created_at))
    );

    // Vienen del más viejo al más nuevo: el primero con un hash es el original.
    const vistos = new Set<string>();
    const adjuntos = filas.map(({ storage_path, content_hash, tipo, nombre: _nombre, reclamo: _reclamo, sin_leer: _sinLeer, descarte, ...f }) => {
      const duplicado = content_hash != null && vistos.has(content_hash);
      if (content_hash != null) vistos.add(content_hash);
      const disponible = storage_path != null && f.rejected_reason == null;
      return {
        ...f,
        external_url: f.external_url ?? "",
        disponible,
        duplicado,
        // Uno descartado la ruta no lo lee: el botón terminaría siempre en «sin leer».
        esPresupuesto:
          disponible &&
          !descarte &&
          esCandidatoAPresupuesto({ content_type: f.content_type, file_name: f.filename, resumen: f.resumen, datos: { tipo } }),
      };
    });
    return { adjuntos, cartas: cartasDe(filas.filter((f) => f.rejected_reason == null)) };
  } catch (err) {
    // Degrada a propósito —la pantalla no se cae porque falle una consulta—
    // pero no en silencio: sin esto, un adjunto que no se pudo leer se ve
    // igual que un caso sin adjuntos, y alguien cierra un caso creyendo que la
    // persona no mandó nada.
    logger.error({ error_code: errorCode(err) }, "cases.detail_view.query_failed");
    return { adjuntos: [], cartas: [] };
  }
}

type PolizaEnCaso = PolizaParaCobertura & { condiciones_path: string | null; condiciones_leidas_en: string | null };

/** La póliza del caso; `null` si ya no existe, `undefined` si la consulta falló. */
async function fetchPoliza(ctx: TenantContext, policyId: string): Promise<PolizaEnCaso | null | undefined> {
  try {
    const filas = await enTenant(ctx, (db) =>
      db
        .select({
          status: policies.status,
          start_date: policies.start_date,
          end_date: policies.end_date,
          coberturas: policies.coberturas,
          ambito_territorial: policies.ambito_territorial,
          condiciones_path: policies.condiciones_path,
          condiciones_leidas_en: policies.condiciones_leidas_en,
          patentes: patentesDe(policies.id),
        })
        .from(policies)
        .where(eq(policies.id, policyId))
        .limit(1)
    );
    return firstRow(filas) ?? null;
  } catch (err) {
    logger.error({ error_code: errorCode(err) }, "cases.detail_view.query_failed");
    return undefined;
  }
}

/** El valor más nuevo que sirva, de la primera clave que lo tenga. */
function campo(
  filas: readonly ExtractedFieldRow[],
  claves: readonly string[],
  sirve: (valor: string) => boolean = (v) => !!v.trim()
): string | null {
  for (const clave of claves) {
    for (let i = filas.length - 1; i >= 0; i--) {
      const f = filas[i]!;
      if (f.field_key === clave && f.field_value && sirve(f.field_value)) return f.field_value;
    }
  }
  return null;
}

function coberturaDelCaso(
  caseRow: CaseRow,
  campos: readonly ExtractedFieldRow[],
  poliza: PolizaEnCaso | null | undefined
): CoberturaEnPantalla | null {
  if (poliza === undefined) return null;
  const monto = caseRow.monto_estimado ?? null;
  const resultado = evaluarCobertura({
    poliza,
    tipo: caseRow.claim_type,
    // «ayer» en accident_date no tapa una fecha que sí se lee en incident_date.
    fechaDelSiniestro: campo(campos, ["accident_date", "fecha_siniestro", "incident_date"], (v) => dia(v) !== null),
    provincia: campo(campos, clavesQueSatisfacen("provincia_siniestro")),
    patente: campo(campos, clavesQueSatisfacen("patente_vehiculo")),
    monto,
  });
  const condiciones = !poliza
    ? "sin_poliza"
    : poliza.condiciones_leidas_en
      ? "leidas"
      : poliza.condiciones_path
        ? "sin_leer"
        : "sin_subir";
  return { resultado, condiciones, monto };
}

/** El nombre de quien tiene asignado el caso, o `null` si no hay o falla la consulta. */
async function fetchNombreAsignado(
  ctx: TenantContext,
  userId: string
): Promise<string | null> {
  return enTenant(ctx, (db) =>
    db.select({ n: users.full_name }).from(users).where(eq(users.id, userId)).limit(1)
  )
    .then((filas) => firstRow(filas)?.n ?? null)
    .catch(() => null);
}

/**
 * Trae el caso y, si existe, todo lo demás en una sola tanda.
 *
 * Devuelve `null` cuando el caso no existe o es de otra aseguradora — nunca
 * por un error de lectura de lo relacionado, que degrada a vacío. Confundir las
 * dos cosas le mostraría al analista que un caso suyo no existe.
 */
export async function cargarDetalleDeCaso(
  ctx: TenantContext,
  caseId: string
): Promise<DetalleDeCaso | null> {
  const caseRow = await fetchCaseRow(ctx, caseId);
  if (!caseRow) return null;

  /*
   * Las confirmaciones sólo existen para los casos que entraron por correo:
   * pedirlas para uno de WhatsApp sería pagar una consulta para recibir vacío.
   *
   * Los ADJUNTOS no: van siempre. Un archivo de WhatsApp que pasa el tope de
   * 10 MB deja igual su fila en `claim_attachments` —sin `storage_path` y con
   * `rejected_reason`—, que es lo que le dice al analista que el asegurado
   * mandó algo y no entró. WhatsApp es el único canal que llega hasta acá sin
   * bytes, y condicionar los adjuntos al correo dejaba a un caso de WhatsApp
   * sin ninguna fila en pantalla, incluida ésa, que se escribe justamente para
   * que se vea.
   *
   * Los MENSAJES tampoco: `raw_messages` la escribe también la ingesta real de
   * WhatsApp —`intake-agent.ts`, justo después de escribir el hilo—, así que
   * condicionarlos al correo dejaría al acordeón de un caso de WhatsApp
   * diciendo «sin texto original» sobre un caso que sí lo tiene.
   */
  const esDeCorreo = caseRow.channel === "email" || caseRow.channel === "email_sim";

  const [extracted_fields, missing_docs, audit_log, confirmations, { adjuntos: attachments, cartas }, messages, asignado_nombre, poliza] =
    await Promise.all([
      fetchExtractedFields(ctx, caseId),
      fetchMissingDocs(ctx, caseId),
      fetchAuditLog(ctx, caseId),
      esDeCorreo ? fetchConfirmaciones(ctx, caseId) : Promise.resolve([]),
      fetchAdjuntos(ctx, caseId),
      mensajesEntrantes(ctx, caseId, { orden: "viejos", tope: MENSAJES_A_MOSTRAR }),
      caseRow.assigned_to ? fetchNombreAsignado(ctx, caseRow.assigned_to) : Promise.resolve(null),
      caseRow.policy_id ? fetchPoliza(ctx, caseRow.policy_id) : Promise.resolve(null),
    ]);

  return {
    case: caseRow,
    extracted_fields,
    missing_docs,
    audit_log,
    confirmations,
    attachments,
    messages,
    hayMasMensajes: messages.length >= MENSAJES_A_MOSTRAR,
    asignado_nombre,
    cobertura: coberturaDelCaso(caseRow, extracted_fields, poliza),
    // Una opinión que quedó de antes de que el caso se reclasificara no se muestra.
    responsabilidad: esChoque(caseRow.claim_type) ? leerResponsabilidad(caseRow.responsabilidad) : null,
    cartas,
  };
}

/**
 * El mensaje que hay que releer con el parser cuando la extracción no dejó
 * campos.
 *
 * Casi siempre sale de los mensajes que ya se trajeron para el acordeón, sin
 * pagar otra consulta. La excepción es real y por eso está escrita: el acordeón
 * pide los CINCO PRIMEROS, así que si hay cinco puede haber más nuevos que no
 * vinieron, y ahí sí hace falta preguntar de nuevo.
 *
 * En la práctica la excepción casi no se da: esto corre sólo cuando la
 * extracción no dejó ningún campo, que es un caso recién llegado y con un
 * mensaje o dos.
 */
export async function ultimoParaReleer(
  ctx: TenantContext,
  caseId: string,
  detalle: Pick<DetalleDeCaso, "messages" | "hayMasMensajes">
): Promise<{ subject: string; body: string; senderEmail: string }> {
  if (detalle.hayMasMensajes) {
    return ultimoMensajeEntrante(ctx, caseId);
  }

  const ultimo = detalle.messages[detalle.messages.length - 1];
  return {
    subject: ultimo?.subject ?? "",
    body: ultimo?.body ?? "",
    senderEmail: ultimo?.from_addr ?? "",
  };
}
