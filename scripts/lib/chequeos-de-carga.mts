/**
 * Lo que los chequeos de `load-test.mts` leen de la base, aparte para poder
 * probarlo sin una: un chequeo que da verde con un resultado que no entendió no
 * se ve en ninguna corrida, se ve en un test.
 */

/** Las filas de un resultado de `db.execute`, venga el driver con `{rows}` o con un arreglo. */
export function filasDe(resultado: unknown): unknown[] {
  return Array.isArray(resultado)
    ? resultado
    : ((resultado as { rows?: unknown[] } | null)?.rows ?? []);
}

/** Las filas de un EXPLAIN, una por línea del plan. */
export function filasDelPlan(resultado: unknown): string[] {
  return filasDe(resultado).map((r) => String(Object.values(r as Record<string, unknown>)[0]));
}

/** Las filas de un EXPLAIN, como un solo texto. */
export function lineasDelPlan(resultado: unknown): string {
  return filasDelPlan(resultado).join(" ");
}

/**
 * Por qué un plan del tablero no entra a `audit_log` por `target_id`, o `null`
 * si entra. Con Postgres 18.7 bajo RLS, `uuid_out` no es leakproof y comparar
 * `target_id` contra `cases.id::text` queda de Filter: cada caso recorre el
 * índice entero. Lo arregla comparar contra `id_txt` (ver `conIdTexto`).
 *
 * Mira filas y no el texto unido, porque tiene que distinguir un Filter de un
 * Index Cond. Un `Recheck Cond` sano re-chequea su propio Index Cond: no cuenta.
 */
export function entraPorTargetId(filas: readonly string[]): string | null {
  if (filas.some((f) => /Hash Join/.test(f))) {
    return "aplanó un lateral en un Hash Join (falta una valla `offset 0`)";
  }
  if (filas.some((f) => /Seq Scan on (?:public\.)?audit_log\b/.test(f))) return "recorre audit_log entera";
  if (filas.some((f) => /\btarget_id\b/.test(f) && !/^\s*(?:Index|Recheck) Cond:/.test(f))) {
    return "compara target_id fuera del índice (falta la valla con id_txt)";
  }
  if (!filas.some((f) => /Index Cond:.*\btarget_id = /.test(f))) return "no entra a la auditoría por target_id";
  return null;
}

/**
 * El número de la primera columna de la primera fila, o `null` si el resultado
 * no trae una fila o no es un número finito. `Number("")` vale 0: leer el
 * conteo con `lineasDelPlan` hacía que un resultado vacío o de otra forma
 * pasara por «cero diferencias».
 */
export function numeroDeLaPrimeraFila(resultado: unknown): number | null {
  const fila = filasDe(resultado)[0];
  if (fila === null || typeof fila !== "object") return null;
  const valor = Object.values(fila)[0];
  const n = typeof valor === "number" ? valor : typeof valor === "string" && valor.trim() !== "" ? Number(valor) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Los índices que el tablero necesita y la migración que crea cada uno: de ahí sale con cuál se repone el que falte. */
export const INDICES_DEL_TABLERO: Record<string, string> = {
  idx_cases_policyholder_name_trgm: "0020",
  idx_cases_policy_number_trgm: "0020",
  idx_cases_tenant_created_at: "0010",
  uq_extracted_field: "0001",
  idx_outbound_messages_case_id: "0001",
  idx_audit_log_target: "0001",
  idx_audit_log_trayecto: "0043",
};
