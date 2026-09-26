/**
 * Reenviar el pedido de datos que falta, y reabrir un caso cerrado por
 * abandono para reenviárselo (P8).
 *
 * Un solo lote de lectura (`consultasDelReenvio`), leído por dos lugares:
 * `acciones.ts` decide qué botón mostrar y esta ruta decide si el reenvío sale
 * de verdad. Comparten `deFilasDelReenvio` / `clavesAbiertas` / `decidirReenvio`
 * para que el botón y el servidor nunca discrepen.
 */

import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { enTenantVarias, type ClienteDatos, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import {
  auditLog,
  cases,
  claimFieldConfirmations,
  claimMessages,
  extractedFields,
  missingDocs,
  rawMessages,
} from "@/lib/db/schema";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";
import type { MotivoSinReenvio } from "@/server/cases/acciones";
import type { RoleContext } from "@/lib/auth/require-role";
import { puedeCambiarEstado } from "@/lib/auth/roles";
import { consultaDelPedido } from "@/server/confirmations/ultimo-pedido";
import { messengerFor } from "@/server/confirmations/messenger";
import { vencimientoDeLaVentana } from "@/core/whatsapp/puede-responder";
import { diaArgentino } from "@/core/fecha/dia-argentino";
import { canonicalFieldKey, isDocument } from "@/lib/labels/claim-fields";
import { clavesQueSatisfacen } from "@/core/case/required-fields";
import { valorLegible } from "@/core/mensajes/valor-legible";
import { esValorVago } from "@/core/mensajes/lo-dicho";
import { MEDIUM_CONFIDENCE_HIGH, MEDIUM_CONFIDENCE_LOW } from "@/server/cases/gap-analyzer";
import { ABANDONABLE_STATUSES } from "@/server/intake/close-abandoned";

/**
 * Las 8 consultas del reenvío, en este orden fijo. `acciones.ts` las agrega a
 * su propio lote con spread; esta ruta las usa solas. Ninguna lleva
 * `.catch()`/`.then()`: `enTenantVarias` necesita el armador de drizzle sin
 * resolver para poder ponerle el contexto del inquilino adelante.
 */
export function consultasDelReenvio(db: ClienteDatos, caseId: string): readonly unknown[] {
  return [
    db
      .select({
        id: cases.id,
        status: cases.status,
        channel: cases.channel,
        assigned_to: cases.assigned_to,
        updated_at: cases.updated_at,
        closed_at: cases.closed_at,
      })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1),

    db
      .select({ from_addr: claimMessages.from_addr, received_at: claimMessages.received_at })
      .from(claimMessages)
      .where(and(eq(claimMessages.case_id, caseId), eq(claimMessages.direction, "inbound")))
      .orderBy(desc(claimMessages.received_at))
      .limit(1),

    // Fallback del flujo simulado: ese canal sólo escribe raw_messages.
    db
      .select({ from_addr: rawMessages.from_addr, received_at: rawMessages.received_at })
      .from(rawMessages)
      .where(eq(rawMessages.case_id, caseId))
      .orderBy(desc(rawMessages.received_at))
      .limit(1),

    consultaDelPedido(db, caseId),

    db
      .select({
        field_key: extractedFields.field_key,
        field_value: extractedFields.field_value,
        confidence: extractedFields.confidence,
      })
      .from(extractedFields)
      .where(eq(extractedFields.case_id, caseId)),

    db
      .select({ doc_key: missingDocs.doc_key })
      .from(missingDocs)
      .where(
        and(
          eq(missingDocs.case_id, caseId),
          isNull(missingDocs.satisfied_at),
          isNull(missingDocs.declined_at)
        )
      ),

    db
      .select({
        field_name: claimFieldConfirmations.field_name,
        status: claimFieldConfirmations.status,
        suggested_value: claimFieldConfirmations.suggested_value,
      })
      .from(claimFieldConfirmations)
      .where(eq(claimFieldConfirmations.case_id, caseId)),

    db
      .select({ event_type: auditLog.event_type, created_at: auditLog.created_at })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target_type, "case"),
          eq(auditLog.target_id, caseId),
          inArray(auditLog.event_type, [AuditEvent.CASE_CLOSED, AuditEvent.CASE_CLOSED_ABANDONED])
        )
      )
      .orderBy(desc(auditLog.created_at))
      .limit(1),
  ];
}

export interface DatosDelReenvio {
  caso: {
    id: string;
    status: string;
    channel: string;
    assigned_to: string | null;
    updated_at: string | null;
    closed_at: string | null;
  } | null;
  destinatario: string | null;
  ultimoEntrante: string | null;
  pedido: { claves: string[]; enviado: string | null };
  campos: Array<{ field_key: string; field_value: string; confidence: number }>;
  docsAbiertos: string[];
  confirmaciones: Array<{ field_name: string; status: string; suggested_value: string | null }>;
  ultimoCierre: string | null;
}

type FilaDeCaso = {
  id: string;
  status: string;
  channel: string;
  assigned_to: string | null;
  updated_at: string | null;
  closed_at: string | null;
};
type FilaDeContacto = { from_addr: string | null; received_at: string };
type FilaDelPedido = { asked_keys: string[] | null; created_at: string };
type FilaDeCampoCruda = { field_key: string; field_value: string | null; confidence: string | number };
type FilaDeConfirmacionCruda = { field_name: string; status: string; suggested_value: string | null };
type FilaDeCierre = { event_type: string; created_at: string };

/**
 * El cierre sólo cuenta si es tan nuevo como el `closed_at` vigente del caso.
 * Sin esto, un `claim.closed_abandoned` de un cierre viejo (reabierto y
 * cerrado de nuevo, esta vez por una persona) sigue siendo la última fila con
 * ese `event_type` y hace pasar un cierre humano por un abandono.
 */
function ultimoCierreVigente(caso: FilaDeCaso | undefined, cierre: FilaDeCierre | undefined): string | null {
  if (!cierre || !caso?.closed_at) return null;
  return new Date(cierre.created_at).getTime() >= new Date(caso.closed_at).getTime()
    ? cierre.event_type
    : null;
}

/** Arma `DatosDelReenvio` a partir de las 8 filas de `consultasDelReenvio`, en el mismo orden. */
export function deFilasDelReenvio(filas: readonly unknown[]): DatosDelReenvio {
  const [
    casoFilas,
    entranteFilas,
    rawFilas,
    pedidoFilas,
    camposFilas,
    docsFilas,
    confFilas,
    cierreFilas,
  ] = filas as [
    FilaDeCaso[],
    FilaDeContacto[],
    FilaDeContacto[],
    FilaDelPedido[],
    FilaDeCampoCruda[],
    Array<{ doc_key: string }>,
    FilaDeConfirmacionCruda[],
    FilaDeCierre[],
  ];

  // El de claim_messages manda; raw_messages es sólo el respaldo del flujo simulado.
  const entrante = entranteFilas[0] ?? rawFilas[0] ?? null;
  const pedidoFila = pedidoFilas[0];

  return {
    caso: casoFilas[0] ?? null,
    destinatario: entrante?.from_addr ?? null,
    ultimoEntrante: entrante?.received_at ?? null,
    pedido: { claves: pedidoFila?.asked_keys ?? [], enviado: pedidoFila?.created_at ?? null },
    campos: camposFilas.map((c) => ({
      field_key: c.field_key,
      field_value: c.field_value ?? "",
      confidence: Number(c.confidence),
    })),
    // Canónicos, como `deHuecos` en gap-analyzer.ts: un hueco de `numero_poliza`
    // y uno de `policy_number` son el mismo hueco.
    docsAbiertos: docsFilas.map((d) => canonicalFieldKey(d.doc_key)),
    confirmaciones: confFilas.map((c) => ({
      field_name: c.field_name,
      status: c.status,
      suggested_value: c.suggested_value,
    })),
    ultimoCierre: ultimoCierreVigente(casoFilas[0], cierreFilas[0]),
  };
}

type Campo = { field_value: string; confidence: number };

/** La entrada de mayor confianza entre las claves que satisfacen la pedida. */
function mejorEntreClaves(fieldMap: Map<string, Campo>, claves: readonly string[]): Campo | undefined {
  let mejor: Campo | undefined;
  for (const clave of claves) {
    const campo = fieldMap.get(canonicalFieldKey(clave));
    if (campo && (!mejor || campo.confidence > mejor.confidence)) mejor = campo;
  }
  return mejor;
}

function nombreDelReclamante(campos: DatosDelReenvio["campos"]): string | null {
  const mejor = mejorEntreClaves(construirFieldMap(campos), ["full_name"]);
  return mejor && mejor.confidence >= MEDIUM_CONFIDENCE_HIGH ? mejor.field_value : null;
}

/** Mapa por clave canónica, mejor confianza gana. Igual que `fieldMap` en gap-analyzer.ts. */
function construirFieldMap(campos: DatosDelReenvio["campos"]): Map<string, Campo> {
  const fieldMap = new Map<string, Campo>();
  for (const c of campos) {
    const key = canonicalFieldKey(c.field_key);
    const existing = fieldMap.get(key);
    if (!existing || c.confidence >= existing.confidence) fieldMap.set(key, c);
  }
  return fieldMap;
}

/**
 * Qué claves del último pedido siguen abiertas, y con qué valor ya sabido —
 * para no pedir dos veces lo mismo con otras palabras.
 *
 * `missing_docs` sólo decide para los documentos: un dato ya contestado no se
 * reabre porque quedó una fila vieja sin cerrar en esa tabla.
 */
export function clavesAbiertas(
  d: DatosDelReenvio,
  hoy: string
): { claves: string[]; conocidos: Record<string, string> } {
  const fieldMap = construirFieldMap(d.campos);
  const porConfirmacion = new Map(
    d.confirmaciones.map((c) => [canonicalFieldKey(c.field_name), c] as const)
  );
  const docsAbiertos = new Set(d.docsAbiertos);

  const claves: string[] = [];
  const conocidos: Record<string, string> = {};

  for (const clave of d.pedido.claves) {
    const confirmacion = porConfirmacion.get(canonicalFieldKey(clave));
    if (confirmacion && (confirmacion.status === "confirmed" || confirmacion.status === "corrected")) {
      continue; // ya lo confirmó una persona
    }

    if (isDocument(clave)) {
      if (docsAbiertos.has(canonicalFieldKey(clave))) claves.push(clave);
      continue;
    }

    if (clave === "email_or_phone" || clave === "email" || clave === "phone") {
      const mejor = mejorEntreClaves(fieldMap, ["email", "phone"]);
      if (!mejor || mejor.confidence < MEDIUM_CONFIDENCE_LOW) claves.push(clave);
      continue;
    }

    const mejor = mejorEntreClaves(fieldMap, clavesQueSatisfacen(clave));
    if (mejor && mejor.confidence >= MEDIUM_CONFIDENCE_HIGH) continue; // ya lo sabemos bien

    claves.push(clave);
    if (mejor && mejor.confidence >= MEDIUM_CONFIDENCE_LOW) {
      const crudo = confirmacion?.suggested_value ?? mejor.field_value;
      if (!esValorVago(clave, crudo)) {
        const legible = valorLegible(clave, crudo, hoy);
        if (legible) conocidos[clave] = legible;
      }
    }
  }

  return { claves, conocidos };
}

export type DecisionDelReenvio =
  | { ok: true; claves: string[]; conocidos: Record<string, string>; reabre: boolean; to: string; claimantName: string | null }
  | { ok: false; motivo: MotivoSinReenvio };

const DIEZ_MINUTOS_MS = 10 * 60 * 1000;

/**
 * Decide si el reenvío sale, en el mismo orden en que se comprueba: el primer
 * motivo que falla es el que se devuelve.
 */
export function decidirReenvio(d: DatosDelReenvio, ahora: Date, reabrir: boolean): DecisionDelReenvio {
  const caso = d.caso;
  if (!caso) return { ok: false, motivo: "estado" };

  let reabre = false;
  if ((ABANDONABLE_STATUSES as readonly string[]).includes(caso.status)) {
    reabre = false;
  } else if (caso.status === "cerrado") {
    if (reabrir && d.ultimoCierre === AuditEvent.CASE_CLOSED_ABANDONED) {
      reabre = true;
    } else {
      return { ok: false, motivo: "cierre_no_es_abandono" };
    }
  } else {
    return { ok: false, motivo: "estado" };
  }

  if (!d.destinatario) return { ok: false, motivo: "sin_destinatario" };

  if (caso.channel === "whatsapp" || caso.channel === "whatsapp_sim") {
    if (!vencimientoDeLaVentana(d.ultimoEntrante, ahora)) {
      return { ok: false, motivo: "ventana_cerrada" };
    }
  }

  const { claves, conocidos } = clavesAbiertas(d, diaArgentino(ahora));
  if (claves.length === 0) return { ok: false, motivo: "nada_pendiente" };

  if (d.pedido.enviado && ahora.getTime() - new Date(d.pedido.enviado).getTime() < DIEZ_MINUTOS_MS) {
    return { ok: false, motivo: "reciente" };
  }

  return {
    ok: true,
    claves,
    conocidos,
    reabre,
    to: d.destinatario,
    claimantName: nombreDelReclamante(d.campos),
  };
}

export type ResultadoDelReenvio =
  | { ok: true; claves: string[]; reabierto: boolean }
  | { ok: false; motivo: MotivoSinReenvio | "no_encontrado" };

/**
 * Reenvía el pedido, y reabre antes si corresponde. Un lote de lectura, un
 * lote de escritura con bloqueo optimista, un mensaje, una línea de auditoría.
 */
export async function reenviarPedido(
  ctx: RoleContext,
  caseId: string,
  reabrir: boolean
): Promise<ResultadoDelReenvio> {
  const tenantCtx: TenantContext = { tenantId: ctx.userRow.tenant_id };

  const filas = await enTenantVarias<readonly unknown[]>(tenantCtx, (db) =>
    consultasDelReenvio(db, caseId)
  );
  const datos = deFilasDelReenvio(filas);
  if (!datos.caso) return { ok: false, motivo: "no_encontrado" };

  // Mismo motivo y misma respuesta que el PATCH: un analista que no es dueño
  // del caso no distingue «no existe» de «no es tuyo».
  if (
    reabrir &&
    !puedeCambiarEstado({ role: ctx.userRow.role, id: ctx.userRow.id }, datos.caso.assigned_to)
  ) {
    return { ok: false, motivo: "no_encontrado" };
  }

  const decision = decidirReenvio(datos, new Date(), reabrir);
  if (!decision.ok) return { ok: false, motivo: decision.motivo };

  const ahora = new Date().toISOString();
  const leido = datos.caso.updated_at;

  let filaEscrita: { id: string } | null = null;
  try {
    if (decision.reabre) {
      const [actualizadas] = await enTenantVarias<[Array<{ id: string }>, unknown]>(
        tenantCtx,
        (db) => [
          db
            .update(cases)
            .set({
              status: "info_faltante",
              closed_at: null,
              para_responder_desde: null,
              updated_at: ahora,
            })
            .where(
              and(
                eq(cases.id, caseId),
                eq(cases.status, "cerrado"),
                sql`${cases.updated_at} is not distinct from ${leido}::timestamptz`
              )
            )
            .returning({ id: cases.id }),
          auditoriaSiQuedo(
            db,
            {
              caseId,
              actorId: ctx.userRow.id,
              eventType: AuditEvent.CASE_STATUS_CHANGED,
              payload: { old_status: "cerrado", new_status: "info_faltante", motivo: "reabrir_abandono" },
            },
            sql`${cases.updated_at} = ${ahora}::timestamptz and ${cases.status} = 'info_faltante'`
          ),
        ]
      );
      filaEscrita = firstRow(actualizadas);
    } else {
      const [actualizadas] = await enTenantVarias<[Array<{ id: string }>]>(tenantCtx, (db) => [
        db
          .update(cases)
          .set({ updated_at: ahora })
          .where(
            and(
              eq(cases.id, caseId),
              inArray(cases.status, [...ABANDONABLE_STATUSES]),
              sql`${cases.updated_at} is not distinct from ${leido}::timestamptz`
            )
          )
          .returning({ id: cases.id }),
      ]);
      filaEscrita = firstRow(actualizadas);
    }
  } catch {
    filaEscrita = null;
  }

  // Cero filas: el caso cambió entre la lectura y la escritura.
  if (!filaEscrita) return { ok: false, motivo: "estado" };

  // Nunca tira: un envío que falla queda registrado adentro, no acá.
  await messengerFor(datos.caso.channel).send({
    caseId,
    tenantId: ctx.userRow.tenant_id,
    to: decision.to,
    template: "missing_information_request",
    data: {
      caseId,
      missingFields: decision.claves,
      knownValues: decision.conocidos,
      claimantName: decision.claimantName,
      isFollowUp: true,
    },
  });

  await writeAuditLog({
    tenant_id: ctx.userRow.tenant_id,
    actor_id: ctx.userRow.id,
    event_type: AuditEvent.CLAIM_REQUEST_RESENT,
    target_type: "case",
    target_id: caseId,
    payload: { claves: decision.claves, reabierto: decision.reabre },
  });

  return { ok: true, claves: decision.claves, reabierto: decision.reabre };
}
