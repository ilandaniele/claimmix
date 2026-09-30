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
 * - case_recordatorios (0039): una etapa gastada no se reescribe ni se borra;
 *   si se pudiera, el barrido la volvería a mandar.
 * - case_plan_pasos (0042): un paso del plan se marca o se desmarca, no se
 *   borra; el rastro de quién lo hizo y cuándo vive en la fila y en audit_log.
 * - asistente_turnos (0043): un turno de la conversación no se reescribe ni se
 *   borra; se va con el caso o con la persona.
 * - case_desvios (0043): los escribe el barrido con el rol dueño; la app sólo
 *   los lee, así que una falla de la app no puede inventarlos ni tapar uno.
 * - formulario_web (0044): apagar el formulario es un UPDATE de `activo`; borrar
 *   la fila liberaría el enlace público sin rastro para que otro lo tome.
 * - adjuntos_por_purgar (0045): la app sólo encola; la cola no se reescribe ni se
 *   vacía desde ahí, y cancelar una purga es un UPDATE que hace el dueño.
 */
export const PERMISOS_QUITADOS = {
  audit_log: ["UPDATE", "DELETE"],
  core_sync_settings: ["DELETE"],
  case_recordatorios: ["UPDATE", "DELETE"],
  case_plan_pasos: ["DELETE"],
  asistente_turnos: ["UPDATE", "DELETE"],
  case_desvios: ["INSERT", "UPDATE", "DELETE"],
  formulario_web: ["DELETE"],
  adjuntos_por_purgar: ["UPDATE", "DELETE"],
};
