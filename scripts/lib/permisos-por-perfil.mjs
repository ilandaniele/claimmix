/**
 * Qué puede hacer `claimmix_app` según la base en la que esté.
 *
 * Con BASE_POR_CLIENTE=1 hay dos clases de base y el mismo rol en las dos
 * (`pg_roles` es del clúster: un rol por base no aísla nada). Lo que cambia es el
 * perfil de permisos:
 *
 * - único: lo de hoy. Una sola base con todo (`sentenciasDelRol`).
 * - cliente: la base `t_<hex>` de un inquilino. Lo que es de control no se ve, y
 *   lo que viene espejado de control (usuarios, números, la fila del inquilino)
 *   sólo se lee, salvo las columnas de configuración.
 * - control: la base `neondb`. Nada de negocio se escribe ahí; SELECT queda
 *   porque la sonda de salud lee `cases` con el centinela.
 *
 * Una sola lista para el script del rol, para la cadena empaquetada que aplica
 * el workflow a una base nueva y para los que verifican. Todas las sentencias
 * son idempotentes y tolerantes a una tabla que todavía no existe.
 */
import { PERMISOS_POR_COLUMNA, sentenciasPorColumna, sentenciasQuitar } from "./permisos-quitados.mjs";

export const ROL_APP = "claimmix_app";

/**
 * Lo que vive en control. `user`, `account`, `session` y `verification` son de
 * Better Auth, que necesita una sola base; el resto lo busca por algo que llega
 * sin inquilino (un número de WhatsApp, una casilla, un dominio de SSO, un slug).
 */
export const TABLAS_DE_CONTROL = [
  "tenants",
  "users",
  "user",
  "account",
  "session",
  "verification",
  "whatsapp_numeros",
  "gmail_accounts",
  "gmail_poll_state",
  "formulario_web",
  "sso_settings",
  "user_ai_settings",
  "rate_limit_counters",
  "audit_log",
  "ai_usage",
  "ai_usage_mensual",
  "tenant_bases",
  "schema_migrations",
];

/** De control pero también presentes en la base del cliente: espejo o copia propia. */
const TAMBIEN_EN_CLIENTE = [
  "tenants",
  "users",
  "user",
  "whatsapp_numeros",
  "audit_log",
  "ai_usage",
  "ai_usage_mensual",
];

/** Las que la base del cliente no puede ni leer. */
export const TABLAS_SOLO_DE_CONTROL = TABLAS_DE_CONTROL.filter((t) => !TAMBIEN_EN_CLIENTE.includes(t));

/** Lo espejado: en la base del cliente la app lo lee y nada más. */
const ESPEJADAS_DE_SOLO_LECTURA = ["users", "user", "whatsapp_numeros"];

/** Las columnas de `tenants` que el equipo edita desde la configuración del inquilino. */
export const COLUMNAS_DE_CONFIG = PERMISOS_POR_COLUMNA.tenants.UPDATE;

const ESCRITURA = "INSERT, UPDATE, DELETE, TRUNCATE";

const sobreTabla = (tabla, sentencia) =>
  `DO $$ BEGIN IF to_regclass('public."${tabla}"') IS NOT NULL THEN ${sentencia}; END IF; END $$`;

const revocar = (tabla, privilegios) => sobreTabla(tabla, `REVOKE ${privilegios} ON public."${tabla}" FROM ${ROL_APP}`);

/**
 * El perfil único: lo que arma `pnpm rol-app` sin `--perfil`. Los quitados y los
 * permisos por columna van después del `GRANT … ON ALL TABLES`, que lo volvería
 * a conceder todo; y los de columna van después de los REVOKE, que los borran.
 */
export const sentenciasDelRol = () => [
  `GRANT USAGE ON SCHEMA public TO ${ROL_APP}`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROL_APP}`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROL_APP}`,
  `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROL_APP}`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROL_APP}`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROL_APP}`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${ROL_APP}`,
  ...sentenciasQuitar(ROL_APP),
  ...sentenciasPorColumna(ROL_APP).map((x) => x.sql),
];

/**
 * Se agregan a `sentenciasDelRol` en la base de un cliente. En `tenants` el
 * REVOKE de tabla borra también las columnas, así que el GRANT va último.
 */
export const sentenciasPerfilCliente = () => [
  ...TABLAS_SOLO_DE_CONTROL.map((t) => revocar(t, "ALL")),
  ...ESPEJADAS_DE_SOLO_LECTURA.map((t) => revocar(t, ESCRITURA)),
  revocar("tenants", ESCRITURA),
  sobreTabla("tenants", `GRANT UPDATE (${COLUMNAS_DE_CONFIG.join(", ")}) ON public."tenants" TO ${ROL_APP}`),
];

/**
 * Se agrega a `sentenciasDelRol` en la base de control: un solo bloque que
 * recorre lo que no es de control y le quita la escritura. SELECT queda.
 */
export const sentenciasPerfilControl = () =>
  [
    "DO $$ DECLARE t text; BEGIN",
    "FOR t IN SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    `WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname::text <> ALL (ARRAY[${TABLAS_DE_CONTROL.map((x) => `'${x}'`).join(", ")}])`,
    `LOOP EXECUTE format('REVOKE ${ESCRITURA} ON TABLE public.%I FROM ${ROL_APP}', t); END LOOP;`,
    "END $$",
  ].join(" ");
