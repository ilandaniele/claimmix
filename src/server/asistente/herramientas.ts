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

import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { enTenant, type TenantContext } from "@/data/scope";
import { digitsOnlyEquals, escapeLike } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import { estadosAConsultar } from "@/core/case/filtro-de-estado";
import type { ConteoDeCasos, Intencion } from "@/core/asistente/intencion";
import { rangoDelPeriodo } from "@/core/metricas/periodo";
import { formatCaseNumber } from "@/core/case/numero";
import { getCaseDetail, type CaseDetail } from "@/server/cases/get";
import { conversacionDelCaso, type Conversacion } from "@/server/cases/conversacion";
import { mensajesSinPiiSiNoCorresponde, OCULTO } from "@/server/cases/pii";
import { redactString } from "@/lib/audit/redact";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import type { CaseStatus } from "@/lib/schemas/cases";

/**
 * `count(*)` de casos, filtrado por período, canal, situación y `is_claim`.
 *
 * `canal` compara contra el valor real de la columna: "email" y "whatsapp"
 * son los canales reales, distintos de "email_sim"/"whatsapp_sim" que deja el
 * simulador — a propósito, para que "¿cuántos por WhatsApp?" cuente tráfico
 * real y no ensayos. Sin canal pedido, igual se restringe a los dos reales
 * (mismo filtro que `consultaDeActividad` en metrics/kpis.ts): si no, un
 * conteo sin filtro incluye los cientos de `email_sim` de batch-simulate y ya
 * no coincide con lo que muestra /metricas.
 */
export async function contarCasos(
  ctx: TenantContext,
  i: Intencion & { herramienta: "contar_casos" }
): Promise<ConteoDeCasos> {
  const { desde, hasta } = rangoDelPeriodo(i.periodo, new Date());

  const condiciones = [gte(cases.created_at, desde), lt(cases.created_at, hasta)];
  condiciones.push(i.canal ? eq(cases.channel, i.canal) : inArray(cases.channel, ["whatsapp", "email"]));
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

export const TOPE_COINCIDENCIAS = 5;
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
  numero: string;
  creado: string;
  estado: CaseStatus;
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
  /** Había más de `TOPE_COINCIDENCIAS` filas: se sigue mostrando sólo el tope. */
  hayMas: boolean;
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

/** Sin acentos ni mayúsculas, de los dos lados de la comparación (`translate` corre en SQL, no acá). */
const SIN_ACENTOS = ["áéíóúüñ", "aeiouun"] as const;

/**
 * Nombre del denunciante o nombre completo extraído — el mismo OR que arma la
 * bandeja con `coalesce` (`server/cases/list.ts`), pero como `EXISTS` porque
 * acá lo que hace falta es la condición del WHERE, no una columna. Insensible
 * a acentos de los dos lados: "Nuñez" tiene que encontrar "Núñez".
 */
function condicionPorNombre(nombre: string) {
  const patron = `%${escapeLike(nombre)}%`;
  return or(
    sql`translate(lower(coalesce(${cases.policyholder_name}, '')), ${SIN_ACENTOS[0]}, ${SIN_ACENTOS[1]}) like translate(lower(${patron}), ${SIN_ACENTOS[0]}, ${SIN_ACENTOS[1]})`,
    sql`exists (
        select 1 from extracted_fields ef
         where ef.case_id = ${cases.id}
           and ef.tenant_id = ${cases.tenant_id}
           and ef.field_key = 'full_name'
           and translate(lower(ef.field_value), ${SIN_ACENTOS[0]}, ${SIN_ACENTOS[1]}) like translate(lower(${patron}), ${SIN_ACENTOS[0]}, ${SIN_ACENTOS[1]})
      )`
  );
}

/**
 * Busca hasta 5 casos por nombre del denunciante, número de póliza o número de
 * caso ("SIN-XXXX-XXXX"). Con exactamente un resultado, trae también el
 * detalle para el resumen (`getCaseDetail` + los últimos 10 mensajes de
 * `conversacionDelCaso`, ya enmascarados y recortados a 500 caracteres cada
 * uno).
 */
export async function buscarCaso(
  ctx: TenantContext,
  i: Intencion & { herramienta: "buscar_caso" },
  rol: string
): Promise<ResultadoDeBusqueda> {
  // El código de caso es el más específico —sale de "SIN-XXXX-XXXX"— y va
  // primero. El número compara sólo dígitos, como `polizas_por_dni` en
  // agent-tools.ts, para tolerar guiones y letras de prefijo en
  // `policy_number`. `condicionPorNombre` escapa `%` y `_` igual que `ilikeAny`.
  const condicion = i.codigo
    ? sql`right(replace(${cases.id}::text, '-', ''), 8) = lower(${i.codigo})`
    : i.numero
      ? digitsOnlyEquals(cases.policy_number, i.numero)
      : i.nombre
        ? condicionPorNombre(i.nombre)
        : undefined;

  if (!condicion) return { coincidencias: [], detalle: null, hayMas: false };

  const filas = await enTenant(ctx, (db) =>
    db
      .select({
        id: cases.id,
        policyholder_name: cases.policyholder_name,
        claim_type: cases.claim_type,
        created_at: cases.created_at,
        status: cases.status,
      })
      .from(cases)
      .where(condicion)
      .orderBy(desc(cases.created_at))
      // Una fila de más para saber si hay que decir "más de 5", sin mostrarla.
      .limit(TOPE_COINCIDENCIAS + 1)
  );

  const hayMas = filas.length > TOPE_COINCIDENCIAS;
  const coincidencias = filas.slice(0, TOPE_COINCIDENCIAS).map((f) => ({
    id: f.id,
    etiqueta: etiquetaDelCaso(f, rol),
    numero: formatCaseNumber(f.id),
    creado: f.created_at,
    estado: f.status,
  }));
  if (coincidencias.length !== 1) return { coincidencias, detalle: null, hayMas };

  const detalle = await detalleParaResumen(ctx.tenantId, filas[0]!.id, rol);
  return { coincidencias, detalle, hayMas };
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
  return detalle ? armarDetalle(detalle, conversacion, rol) : null;
}

/**
 * El detalle enmascarado por rol, sin tocar la base. Lo comparten el resumen de
 * un caso y la pregunta sobre un caso: que el modelo lea lo mismo que ve la
 * persona, ni un dato más.
 */
export function armarDetalle(
  detalle: Pick<CaseDetail, "case" | "extracted_fields" | "missing_docs">,
  conversacion: Conversacion | null,
  rol: string
): DetalleDelCaso {
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
