/**
 * La agenda: tres vencimientos, en un solo viaje y paginados.
 *
 * - La ventana de 24 h de WhatsApp: el último entrante más
 *   `VENTANA_WHATSAPP_MS` (`@/core/whatsapp/puede-responder`), la misma cuenta
 *   que ya deciden el botón de responder y el reenvío.
 * - El cierre por abandono usa el mismo criterio que `close-abandoned.ts`: los
 *   estados de `ABANDONABLE_STATUSES` y sólo si `leLlegoLaPregunta` — un caso
 *   al que nunca le llegó la pregunta no tiene nada por vencer, tiene un envío
 *   que se cayó.
 * - El plazo del caso (B10): `vence_en`, mientras el caso no esté cerrado.
 *
 * Las tres ramas se unen en SQL, con el `vence` ya calculado, y se ordenan y
 * se cortan en la base. Antes se traían 100 de cada tipo y se ordenaban en JS:
 * con más de 100 casos de un tipo, los del segundo quedaban sin verse nunca.
 * El conteo y la página van en el mismo lote (una transacción), así el total
 * y las filas ven lo mismo.
 *
 * D-D1: la agenda la abre cualquier rol, pero `titular` sale tapado con
 * `OCULTO` para quien no está en `CUSTOMER_PII_ROLES`. Va acá y no en la
 * página porque es lo único de este archivo que se puede probar sin levantar
 * un Server Component (ver `tests/unit/server/cases/agenda.test.ts`).
 */
import "server-only";

import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { enTenantVarias, type TenantContext } from "@/data/scope";
import type { Pagina } from "@/lib/db/paginacion";
import { cases, claimMessages } from "@/lib/db/schema";
import { formatCaseNumber } from "@/core/case/numero";
import { ESTADOS_CERRADOS } from "@/core/case/fsm";
import { VENTANA_WHATSAPP_MS } from "@/core/whatsapp/puede-responder";
import {
  ABANDONABLE_STATUSES,
  getAbandonAfterDays,
  leLlegoLaPregunta,
} from "@/server/intake/close-abandoned";
import { camposDePagina } from "@/lib/schemas/paginacion";
import { titularParaElRol } from "@/server/cases/pii";

export type TipoDeVencimiento = "ventana_whatsapp" | "cierre_por_abandono" | "plazo";

export interface Vencimiento {
  caseId: string;
  numero: string;
  titular: string | null;
  tipo: TipoDeVencimiento;
  vence: string;
}

export const PaginaDeAgendaSchema = z.object(camposDePagina);
export type PaginaDeAgenda = z.infer<typeof PaginaDeAgendaSchema>;

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

/**
 * Las tres ramas con la misma forma: `case_id`, `titular`, `tipo` y `vence`.
 *
 * `numero` no viaja: sale del id con `formatCaseNumber`, que es la cuenta que
 * ya usan el resto de las pantallas y no conviene tener dos.
 */
function ramasDeLaAgenda(ahora: Date, dias: number) {
  const ventana = sql`
    select ${cases.id} as case_id, ${cases.policyholder_name} as titular, 'ventana_whatsapp' as tipo,
           ${ultimoEntranteWhatsApp} + make_interval(secs => ${VENTANA_WHATSAPP_MS / 1000}::float8) as vence
      from ${cases}
     where ${and(
       isNotNull(cases.para_responder_desde),
       inArray(cases.channel, ["whatsapp", "whatsapp_sim"]),
       // Una ventana que ya cerró no es un vencimiento, es historia. Acotarla
       // acá evita que la agenda se llene de ellas.
       sql`${ultimoEntranteWhatsApp} > ${new Date(ahora.getTime() - VENTANA_WHATSAPP_MS).toISOString()}::timestamptz`
     )}`;

  const abandono = sql`
    select ${cases.id} as case_id, ${cases.policyholder_name} as titular, 'cierre_por_abandono' as tipo,
           ${desdeQueEspera} + make_interval(days => ${dias}::int) as vence
      from ${cases}
     where ${and(inArray(cases.status, [...ABANDONABLE_STATUSES]), leLlegoLaPregunta)}`;

  // Un caso cerrado ya no tiene plazo que cumplir: si llegó a cerrarse con
  // `vence_en` puesto (el barrido de abandono no lo limpia), no se agenda.
  const plazo = sql`
    select ${cases.id} as case_id, ${cases.policyholder_name} as titular, 'plazo' as tipo,
           ${cases.vence_en} as vence
      from ${cases}
     where ${and(
       isNotNull(cases.vence_en),
       sql`${cases.status} not in ${[...ESTADOS_CERRADOS]}`
     )}`;

  return sql`(${ventana} union all ${abandono} union all ${plazo}) as agenda`;
}

interface FilaDeAgenda {
  case_id: string;
  titular: string | null;
  tipo: TipoDeVencimiento;
  vence: string;
}

export async function leerAgenda(
  ctx: TenantContext,
  ahora: Date,
  rol: string,
  entrada: Partial<PaginaDeAgenda> = {}
): Promise<Pagina<Vencimiento>> {
  const { page, per_page } = PaginaDeAgendaSchema.parse(entrada);
  const ramas = ramasDeLaAgenda(ahora, getAbandonAfterDays());

  const [conteo, filas] = await enTenantVarias<[Array<{ n: number }>, FilaDeAgenda[]]>(ctx, (db) => [
    db.select({ n: sql<number>`count(*)::int` }).from(ramas),
    db
      .select({
        case_id: sql<string>`case_id`,
        titular: sql<string | null>`titular`,
        tipo: sql<TipoDeVencimiento>`tipo`,
        vence: sql<string>`vence`,
      })
      .from(ramas)
      .orderBy(sql`vence`, sql`case_id`)
      .limit(per_page)
      .offset((page - 1) * per_page),
  ]);

  const total = conteo[0]?.n ?? 0;
  return {
    data: filas.map((f) => ({
      caseId: f.case_id,
      numero: formatCaseNumber(f.case_id),
      titular: titularParaElRol(f.titular, rol),
      tipo: f.tipo,
      vence: new Date(f.vence).toISOString(),
    })),
    meta: { total, page, per_page, pages: Math.ceil(total / per_page) },
  };
}
