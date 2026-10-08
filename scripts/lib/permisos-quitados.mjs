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
 * - ai_usage_mensual (0046): lo escribe el trigger de `ai_usage` con SECURITY
 *   DEFINER; la app sólo lo lee, así que no puede falsear lo que ve el tablero.
 * - tenants (0048): la app no crea ni borra inquilinos (lo hace la función
 *   claimmix_crear_inquilino) y el UPDATE queda sólo en las columnas de
 *   PERMISOS_POR_COLUMNA: plan, estado de cobro y prueba los fija el operador.
 * - whatsapp_numeros (0048): la app sólo lo lee; escriben la función de alta y el
 *   rol dueño, así que una falla de la app no puede quedarse con un número ajeno.
 * - account, session y verification (0048): hashes de contraseña, tokens de
 *   sesión y de restablecimiento. Better Auth y `cerrarSesiones` usan el rol
 *   dueño; la app no tiene nada que hacer ahí. De account se recuperan por
 *   columna las dos que no guardan secretos (PERMISOS_POR_COLUMNA).
 * - user (0048): la app lee el mail y el nombre para los cruces, pero no los
 *   escribe: eso lo hace Better Auth.
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
  ai_usage_mensual: ["INSERT", "UPDATE", "DELETE"],
  tenants: ["INSERT", "UPDATE", "DELETE"],
  whatsapp_numeros: ["INSERT", "UPDATE", "DELETE"],
  account: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  session: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  verification: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  user: ["INSERT", "UPDATE", "DELETE"],
};

/**
 * Lo que `claimmix_app` SÍ puede, columna por columna, sobre una tabla a la que
 * PERMISOS_QUITADOS le sacó el permiso entero. Un REVOKE de tabla también borra
 * los permisos por columna: `create-app-role` los concede DESPUÉS del bucle y
 * `pnpm permisos` exige exactamente este conjunto.
 *
 * - tenants.UPDATE (0048): las siete columnas de configuración que el equipo
 *   edita desde la app. Todo lo demás (plan, cobro, prueba, contacto, nombre,
 *   autoalta) es del operador.
 * - account.SELECT (0048): `provider_id` y `user_id` bastan para saber por qué
 *   proveedor entró una persona (exigir SSO); no guardan ningún secreto.
 */
export const PERMISOS_POR_COLUMNA = {
  tenants: {
    UPDATE: [
      "specialist_alert_emails",
      "recordatorio_horas",
      "rangos_de_monto",
      "reglas_asignacion",
      "plazos",
      "plan_por_tipo",
      "pesos_puntaje",
    ],
  },
  account: {
    SELECT: ["provider_id", "user_id"],
  },
};

/**
 * Las sentencias que dejan a `rol` con los permisos de `claimmix_app`, para
 * `create-app-role` y para el rol del ensayo de tenencia. Van después del
 * `GRANT … ON ALL TABLES`, que lo volvería a conceder todo. En una base todavía
 * sin migrar la tabla no existe: no hay nada que sacar ni que dar. El nombre va
 * entre comillas porque `user` es palabra reservada.
 */
export const sentenciasQuitar = (rol) =>
  Object.entries(PERMISOS_QUITADOS).map(
    ([tabla, privilegios]) =>
      `DO $$ BEGIN IF to_regclass('public."${tabla}"') IS NOT NULL THEN REVOKE ${privilegios.join(", ")} ON public."${tabla}" FROM ${rol}; END IF; END $$`,
  );

/** Van después de `sentenciasQuitar`: un REVOKE de tabla también borra los permisos por columna. */
export const sentenciasPorColumna = (rol) =>
  Object.entries(PERMISOS_POR_COLUMNA).flatMap(([tabla, porPrivilegio]) =>
    Object.entries(porPrivilegio).map(([privilegio, columnas]) => ({
      sql: `DO $$ BEGIN IF to_regclass('public."${tabla}"') IS NOT NULL THEN GRANT ${privilegio} (${columnas.join(", ")}) ON public."${tabla}" TO ${rol}; END IF; END $$`,
      resumen: `${privilegio} sólo en ${tabla} (${columnas.join(", ")})`,
    })),
  );
