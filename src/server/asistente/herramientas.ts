/**
 * Las dos consultas de lectura que el asistente puede correr.
 *
 * El modelo NUNCA llega hasta acá con texto libre: sólo con una `Intencion` ya
 * validada por `IntencionSchema` (ver `@/core/asistente/intencion`). Lo que
 * corre en este archivo son consultas fijas y parametrizadas bajo `enTenant`,
 * que es lo mismo que dice cualquier otra consulta del producto — no hay SQL
 * libre ni un camino que cruce de inquilino.
 *
 * El enmascarado por rol vive acá y no en `responder.ts` a propósito: es el
 * mismo dato el que va al modelo (para el resumen) y el que vuelve a la
 * pantalla, así que si se enmascara antes de armar la respuesta, el modelo
 * nunca llega a leer lo que un viewer no puede ver.
 *
 * `sinPiiSiNoCorresponde` (de `@/server/cases/pii.ts`) no aplica tal cual:
 * espera la forma de una corrida del agente (`input_payload.{subject,body,
 * sender_email}`), no la de un caso. Acá se sigue el mismo criterio —viewer
 * enmascarado, el resto no— con `mensajesSinPiiSiNoCorresponde` para los
 * mensajes y un enmascarado propio, con el mismo `OCULTO`, para el nombre, la
 * póliza y los campos extraídos identificatorios.
 */

import "server-only";

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { enTenant, type TenantContext } from "@/data/scope";
import { ilikeAny } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import { estadosAConsultar } from "@/core/case/filtro-de-estado";
import type { ConteoDeCasos, Intencion } from "@/core/asistente/intencion";
import { rangoDelPeriodo } from "@/core/asistente/intencion";
import { getCaseDetail } from "@/server/cases/get";
import { conversacionDelCaso } from "@/server/cases/conversacion";
import { mensajesSinPiiSiNoCorresponde, OCULTO } from "@/server/cases/pii";
import { redactString } from "@/lib/audit/redact";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";

/**
 * `count(*)` de casos, filtrado por período, canal, situación y `is_claim`.
 *
 * `canal` compara contra el valor real de la columna: "email" y "whatsapp"
 * son los canales reales, distintos de "email_sim"/"whatsapp_sim" que deja el
 * simulador — a propósito, para que "¿cuántos por WhatsApp?" cuente tráfico
 * real y no ensayos.
 */
export async function contarCasos(
  ctx: TenantContext,
  i: Intencion & { herramienta: "contar_casos" }
): Promise<ConteoDeCasos> {
  const { desde, hasta } = rangoDelPeriodo(i.periodo, new Date());

  const condiciones = [gte(cases.created_at, desde), lt(cases.created_at, hasta)];
  if (i.canal) condiciones.push(eq(cases.channel, i.canal));
  if (i.situacion) condiciones.push(inArray(cases.status, estadosAConsultar(i.situacion)));
  if (i.solo_reclamos) condiciones.push(eq(cases.is_claim, true));

  const filas = await enTenant<Array<{ n: number }>>(ctx, (db) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(...condiciones))
  );

  return { total: filas[0]?.n ?? 0 };
}

const TOPE_COINCIDENCIAS = 5;
const TOPE_MENSAJES_RESUMEN = 10;
const TOPE_CARACTERES_MENSAJE = 500;

/** Los campos extraídos que identifican a una persona: para un viewer se ocultan, no se enmascaran a medias. */
const CAMPOS_IDENTIFICATORIOS = new Set([
  "full_name",
  "email",
  "phone",
  "email_or_phone",
  "dni",
  "policy_number",
]);

export interface CasoEncontrado {
  id: string;
  etiqueta: string;
}

/** Lo que se le pasa al prompt de resumen y lo que arma el resumen determinístico de respaldo. */
export interface DetalleDelCaso {
  id: string;
  titular: string | null;
  poliza: string | null;
  tipo: string | null;
  estado: string;
  creado: string;
  cerrado: string | null;
  campos: Array<{ clave: string; valor: string }>;
  documentos_faltantes: string[];
  mensajes: Array<{ direccion: "inbound" | "outbound"; texto: string | null }>;
}

export interface ResultadoDeBusqueda {
  coincidencias: CasoEncontrado[];
  /** Sólo cuando `coincidencias.length === 1`. */
  detalle: DetalleDelCaso | null;
}

function etiquetaDelCaso(
  row: { policyholder_name: string | null; claim_type: string | null },
  rol: string
): string {
  const nombre = row.policyholder_name
    ? rol === "viewer"
      ? OCULTO
      : row.policyholder_name
    : null;
  return [nombre, row.claim_type].filter((x): x is string => !!x).join(" — ") || "sin nombre";
}

/**
 * Busca hasta 5 casos por nombre del denunciante o por los dígitos del número
 * de póliza. Con exactamente un resultado, trae también el detalle para el
 * resumen (`getCaseDetail` + los últimos 10 mensajes de `conversacionDelCaso`,
 * ya enmascarados y recortados a 500 caracteres cada uno).
 */
export async function buscarCaso(
  ctx: TenantContext,
  i: Intencion & { herramienta: "buscar_caso" },
  rol: string
): Promise<ResultadoDeBusqueda> {
  // `ilikeAny` escapa `%` y `_`; el número compara sólo dígitos, como
  // `polizas_por_dni` en agent-tools.ts, para tolerar guiones y letras de
  // prefijo en `policy_number`.
  const condicion = i.numero
    ? sql`regexp_replace(coalesce(${cases.policy_number}, ''), '[^0-9]', '', 'g') = ${i.numero}`
    : i.nombre
      ? ilikeAny([cases.policyholder_name], i.nombre)
      : undefined;

  if (!condicion) return { coincidencias: [], detalle: null };

  const filas = await enTenant(ctx, (db) =>
    db
      .select({
        id: cases.id,
        policyholder_name: cases.policyholder_name,
        claim_type: cases.claim_type,
      })
      .from(cases)
      .where(condicion)
      .orderBy(desc(cases.created_at))
      .limit(TOPE_COINCIDENCIAS)
  );

  const coincidencias = filas.map((f) => ({ id: f.id, etiqueta: etiquetaDelCaso(f, rol) }));
  if (coincidencias.length !== 1) return { coincidencias, detalle: null };

  const detalle = await detalleParaResumen(ctx.tenantId, filas[0]!.id, rol);
  return { coincidencias, detalle };
}

/** `null` cuando el caso desapareció entre la búsqueda y este segundo viaje (borrado, o un hipo de la consulta). */
async function detalleParaResumen(
  tenantId: string,
  caseId: string,
  rol: string
): Promise<DetalleDelCaso | null> {
  const tenantCtx: TenantContext = { tenantId };
  const [detalle, conversacion] = await Promise.all([
    getCaseDetail(tenantId, caseId),
    conversacionDelCaso(tenantCtx, caseId),
  ]);
  if (!detalle) return null;

  const esViewer = rol === "viewer";

  const campos = detalle.extracted_fields.map((f) => {
    const clave = canonicalFieldKey(f.field_key);
    const valorCrudo = f.field_value ?? "";
    const valor =
      esViewer && CAMPOS_IDENTIFICATORIOS.has(clave) ? OCULTO : redactString(valorCrudo);
    return { clave, valor };
  });

  const mensajes = mensajesSinPiiSiNoCorresponde(conversacion?.messages ?? [], rol)
    .slice(-TOPE_MENSAJES_RESUMEN)
    .map((m) => ({
      direccion: m.direction,
      texto: m.body_text ? m.body_text.slice(0, TOPE_CARACTERES_MENSAJE) : null,
    }));

  return {
    id: detalle.case.id,
    titular: esViewer ? (detalle.case.policyholder_name ? OCULTO : null) : detalle.case.policyholder_name,
    poliza: esViewer ? (detalle.case.policy_number ? OCULTO : null) : detalle.case.policy_number,
    tipo: detalle.case.claim_type,
    estado: detalle.case.status,
    creado: detalle.case.created_at,
    cerrado: detalle.case.closed_at,
    campos,
    documentos_faltantes: detalle.missing_docs
      .filter((d) => !d.satisfied_at && !d.declined_at)
      .map((d) => d.doc_key),
    mensajes,
  };
}
