/**
 * Lo que contesta Google cuando el permiso de una casilla se revocó o venció
 * (`invalid_grant` al refrescar el token). Es también el valor que queda en
 * `gmail_accounts.last_error` para que el panel la muestre vencida.
 */
export const CASILLA_VENCIDA = "invalid_grant";

/** Hay que reconectar la casilla. El status no alcanza: un 400 también es un destinatario malo. */
export function esPermisoRevocado(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } };
  return e.response?.data?.error === CASILLA_VENCIDA ||
    (typeof e.message === "string" && e.message.includes(CASILLA_VENCIDA));
}
