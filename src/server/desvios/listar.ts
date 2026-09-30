/**
 * Los desvíos de la revisión nocturna (B22), para la pantalla del equipo.
 *
 * Un desvío es historia: no se resuelve solo cuando el caso se arregla. Por eso
 * la lista trae todos, del más nuevo al más viejo, y cada uno lleva el caso al
 * que apunta para abrirlo.
 *
 * El aislamiento por inquilino lo pone RLS (`claimmix_app` sólo lee); la
 * pantalla ya está cerrada a `REVISION_ROLES`, y el titular sale tapado igual
 * para quien no puede ver el padrón.
 */
import "server-only";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext } from "@/data/scope";
import { formatCaseNumber } from "@/core/case/numero";
import { REQUIRED_DOCS_CONFIG } from "@/core/case/required-docs";
import { clavesDelDato } from "@/core/desvios/reglas";
import type { Locale } from "@/lib/i18n";
import { etiquetaDeCampo } from "@/lib/labels/etiqueta-de-campo";
import type { ClaimType } from "@/lib/schemas/cases";
import { paginarEnTenant, type Pagina } from "@/lib/db/paginacion";
import { caseDesvios, cases } from "@/lib/db/schema";
import { camposDePagina } from "@/lib/schemas/paginacion";
import { titularParaElRol } from "@/server/cases/pii";

export const PaginaDeDesviosSchema = z.object(camposDePagina);
export type PaginaDeDesvios = z.infer<typeof PaginaDeDesviosSchema>;

export interface Desvio {
  caseId: string;
  numero: string;
  titular: string | null;
  /** El tipo de reclamo del caso: de él depende cómo se llama cada documento. */
  tipo: string | null;
  /** El nombre de la regla; una que ya no exista se muestra tal cual. */
  regla: string;
  /** El instante del hecho que causó el desvío. */
  ancla: string;
  detectadoEn: string;
  /** Las claves que guardó la regla, ya validadas. */
  datos: string[];
}

/**
 * La etiqueta de un documento para el tipo de reclamo del caso: la misma clave
 * se dice distinto según el tipo («Fotos de los daños», «Fotos del vidrio
 * dañado»...), así que no hay una etiqueta por clave sola. Esa configuración
 * sólo está en castellano: en otro idioma se dice como en la pantalla del caso,
 * con el diccionario.
 */
export function etiquetaDeDocumento(
  clave: string,
  tipo: string | null,
  locale: Locale,
  t: Parameters<typeof etiquetaDeCampo>[1]
): string {
  if (locale !== "es-AR") return etiquetaDeCampo(clave, t);
  const pedidos = tipo !== null && Object.hasOwn(REQUIRED_DOCS_CONFIG, tipo) ? REQUIRED_DOCS_CONFIG[tipo as ClaimType] : [];
  const pedido = pedidos.find((d) => d.doc_key === clave);
  return pedido?.label_es ?? clave.replace(/_/g, " ");
}

export async function listarDesvios(
  ctx: TenantContext,
  rol: string,
  entrada: Partial<PaginaDeDesvios> = {}
): Promise<Pagina<Desvio>> {
  const { page, per_page } = PaginaDeDesviosSchema.parse(entrada);

  const pagina = await paginarEnTenant<{
    case_id: string;
    titular: string | null;
    tipo: string | null;
    regla: string;
    ancla: string;
    detectado_en: string;
    dato: string | null;
  }>(ctx, { tabla: caseDesvios, page, per_page }, (db) =>
    db
      .select({
        case_id: caseDesvios.case_id,
        titular: cases.policyholder_name,
        tipo: cases.claim_type,
        regla: caseDesvios.regla,
        ancla: caseDesvios.ancla,
        detectado_en: caseDesvios.detectado_en,
        dato: caseDesvios.dato,
      })
      .from(caseDesvios)
      .innerJoin(cases, eq(cases.id, caseDesvios.case_id))
      .orderBy(desc(caseDesvios.detectado_en), desc(caseDesvios.ancla), caseDesvios.case_id, caseDesvios.regla)
      .limit(per_page)
      .offset((page - 1) * per_page)
  );

  return {
    data: pagina.data.map((f) => ({
      caseId: f.case_id,
      numero: formatCaseNumber(f.case_id),
      titular: titularParaElRol(f.titular, rol),
      tipo: f.tipo,
      regla: f.regla,
      ancla: new Date(f.ancla).toISOString(),
      detectadoEn: new Date(f.detectado_en).toISOString(),
      datos: clavesDelDato(f.dato),
    })),
    meta: pagina.meta,
  };
}
