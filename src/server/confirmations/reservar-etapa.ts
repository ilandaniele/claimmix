/**
 * Reserva una etapa de recordatorio (o el aviso de cierre) antes de mandar.
 *
 * La clave primaria de `case_recordatorios` es la idempotencia: dos corridas
 * sobre la misma etapa insertan una sola fila, y la que no la inserta no
 * manda. Las etapas anteriores que no se hicieron entran como `salteado` en la
 * misma sentencia, para que una etapa vieja no salga después de una nueva.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { ClienteDatos } from "@/data/scope";
import { caseRecordatorios, cases } from "@/lib/db/schema";

export interface Reserva {
  caseId: string;
  tenantId: string;
  ancla: string;
  /** Primera etapa a insertar; las que hay entre esta y `etapa` quedan `salteado`. */
  desde: number;
  etapa: number;
  /** `enviar` o el motivo del salteo. */
  resultado: string;
  /** Lo que el caso tiene que seguir cumpliendo; si no, no se reserva nada. */
  sigue: SQL;
}

export function reservarEtapa(db: ClienteDatos, r: Reserva) {
  return db
    .insert(caseRecordatorios)
    .select(
      sql`select ${r.caseId}::uuid, ${r.tenantId}::uuid, ${r.ancla}::timestamptz, e::smallint,
        case when e = ${r.etapa}::int then ${r.resultado}::text else 'salteado' end, now()
        from generate_series(${r.desde}::int, ${r.etapa}::int) as e
        where exists (select 1 from ${cases} where ${cases.id} = ${r.caseId} and ${r.sigue})`
    )
    .onConflictDoNothing()
    .returning({ etapa: caseRecordatorios.etapa });
}
