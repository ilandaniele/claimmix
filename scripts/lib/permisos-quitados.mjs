/**
 * Lo que `claimmix_app` NO puede hacer, por tabla.
 *
 * `create-app-role` concede todo sobre todas las tablas y después quita esto;
 * `pnpm permisos` falla si el rol lo tiene. Una sola lista para que las dos
 * puntas no se desfasen cuando una migración nueva saca un permiso.
 *
 * - audit_log (0032): sólo de alta; la auditoría no se reescribe.
 * - core_sync_settings (0036): apagar la entrega o revocar la clave es un
 *   UPDATE que queda en audit_log; borrar la fila no dejaría rastro.
 */
export const PERMISOS_QUITADOS = {
  audit_log: ["UPDATE", "DELETE"],
  core_sync_settings: ["DELETE"],
};
