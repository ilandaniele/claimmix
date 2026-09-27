/**
 * La agenda: dos vencimientos que ya salen de datos existentes, en un solo
 * viaje.
 *
 * - La ventana de 24 h de WhatsApp usa `vencimientoDeLaVentana`
 *   (`@/core/whatsapp/puede-responder`), la misma cuenta que ya deciden el
 *   botón de responder y el reenvío.
 * - El cierre por abandono usa el mismo criterio que `close-abandoned.ts`: los
 *   estados de `ABANDONABLE_STATUSES` y sólo si `leLlegoLaPregunta` — un caso
 *   al que nunca le llegó la pregunta no tiene nada por vencer, tiene un envío
 *   que se cayó.
 *
 * D-D1: la agenda la abre cualquier rol, pero `titular` sale tapado con
 * `OCULTO` para quien no está en `CUSTOMER_PII_ROLES`. Va acá y no en la
 * página porque es lo único de este archivo que se puede probar sin levantar
 * un Server Component (ver `tests/unit/server/cases/agenda.test.ts`).
 */
import "server-only";

import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { enTenantVarias, type TenantContext } from "@/data/scope";
import { cases, claimMessages } from "@/lib/db/schema";
import { formatCaseNumber } from "@/core/case/numero";
import { VENTANA_WHATSAPP_MS, vencimientoDeLaVentana } from "@/core/whatsapp/puede-responder";
import {
  ABANDONABLE_STATUSES,
  getAbandonAfterDays,
  leLlegoLaPregunta,
} from "@/server/intake/close-abandoned";
import { CUSTOMER_PII_ROLES } from "@/lib/auth/roles";
import { OCULTO } from "@/server/cases/pii";

export type TipoDeVencimiento = "ventana_whatsapp" | "cierre_por_abandono";

export interface Vencimiento {
  caseId: string;
  numero: string;
  titular: string | null;
  tipo: TipoDeVencimiento;
  vence: string;
}

const TOPE_AGENDA = 100;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** El último entrante de WhatsApp del caso: de ahí cuenta la ventana de 24 h. */
const ultimoEntranteWhatsApp = sql<string | null>`(
  select ${claimMessages.received_at}
    from ${claimMessages}
   where ${claimMessages.case_id} = ${cases.id}
     and ${claimMessages.direction} = 'inbound'
     and ${claimMessages.provider} = 'whatsapp'
   order by ${claimMessages.received_at} desc
   limit 1
)`;

/** Desde cuándo cuenta el abandono: lo mismo que usa el barrido. */
const desdeQueEspera = sql<string>`coalesce(${cases.updated_at}, ${cases.created_at})`;

/** El nombre, o `OCULTO` si hay algo que tapar y el rol no puede verlo. */
function titularDe(nombre: string | null, puedeVerTitular: boolean): string | null {
  if (puedeVerTitular) return nombre;
  return nombre ? OCULTO : null;
}

export async function leerAgenda(
  ctx: TenantContext,
  ahora: Date,
  rol: string
): Promise<Vencimiento[]> {
  const puedeVerTitular = (CUSTOMER_PII_ROLES as readonly string[]).includes(rol);
  const dias = getAbandonAfterDays();

  const [ventanas, abandonos] = await enTenantVarias<
    [
      Array<{ id: string; titular: string | null; ultimoEntrante: string | null }>,
      Array<{ id: string; titular: string | null; desde: string }>,
    ]
  >(ctx, (db) => [
    db
      .select({
        id: cases.id,
        titular: cases.policyholder_name,
        ultimoEntrante: ultimoEntranteWhatsApp,
      })
      .from(cases)
      .where(
        and(
          isNotNull(cases.para_responder_desde),
          inArray(cases.channel, ["whatsapp", "whatsapp_sim"]),
          // Acota en SQL, no sólo en JS: si no, el LIMIT se lo puede comer
          // entero un tenant con más de 100 ventanas ya vencidas y la agenda
          // no llega a ver ninguna viva.
          sql`${ultimoEntranteWhatsApp} > ${new Date(ahora.getTime() - VENTANA_WHATSAPP_MS).toISOString()}::timestamptz`
        )
      )
      .orderBy(ultimoEntranteWhatsApp)
      .limit(TOPE_AGENDA),
    db
      .select({ id: cases.id, titular: cases.policyholder_name, desde: desdeQueEspera })
      .from(cases)
      .where(and(inArray(cases.status, [...ABANDONABLE_STATUSES]), leLlegoLaPregunta))
      .orderBy(desdeQueEspera)
      .limit(TOPE_AGENDA),
  ]);

  const vencimientos: Vencimiento[] = [];

  for (const c of ventanas) {
    const vence = vencimientoDeLaVentana(c.ultimoEntrante, ahora);
    // Ya pasó: no es un vencimiento, es historia.
    if (!vence) continue;
    vencimientos.push({
      caseId: c.id,
      numero: formatCaseNumber(c.id),
      titular: titularDe(c.titular, puedeVerTitular),
      tipo: "ventana_whatsapp",
      vence: vence.toISOString(),
    });
  }

  for (const c of abandonos) {
    vencimientos.push({
      caseId: c.id,
      numero: formatCaseNumber(c.id),
      titular: titularDe(c.titular, puedeVerTitular),
      tipo: "cierre_por_abandono",
      vence: new Date(new Date(c.desde).getTime() + dias * MS_POR_DIA).toISOString(),
    });
  }

  vencimientos.sort((a, b) => Date.parse(a.vence) - Date.parse(b.vence));
  return vencimientos.slice(0, TOPE_AGENDA);
}
