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

/** Las filas de un EXPLAIN, como un solo texto. */
export function lineasDelPlan(resultado: unknown): string {
  return filasDe(resultado)
    .map((r) => Object.values(r as Record<string, unknown>)[0])
    .join(" ");
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
  idx_extracted_fields_case_id: "0001",
  idx_outbound_messages_case_id: "0001",
  idx_audit_log_trayecto: "0043",
};
