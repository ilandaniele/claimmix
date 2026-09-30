/**
 * Quién puede hacer qué, sin arrastrar la base de datos.
 *
 * Estas constantes vivían en `require-role.ts`, que importa `@/lib/db` para
 * poder mirar la sesión. Eso las volvía inservibles desde un componente de
 * cliente: la barra lateral necesita saber si mostrar «Clientes» y no puede
 * pagar el precio de meter el driver de Postgres en el bundle del navegador.
 *
 * La alternativa —copiar la lista de roles en la barra— es cómo una guarda y su
 * menú terminan diciendo cosas distintas. Un archivo sin dependencias las deja
 * en un solo lugar, y `require-role.ts` las vuelve a exportar para que nada de
 * lo que ya las importaba tenga que cambiar.
 *
 * Lo que va acá no es una guarda: es la LISTA. La guarda de verdad sigue siendo
 * el chequeo del servidor. Esconder un enlace nunca fue una defensa.
 */

export const ALL_ROLES = ["owner", "admin", "specialist", "analyst", "viewer"] as const;
export type UserRole = (typeof ALL_ROLES)[number];

/** Roles allowed to confirm training examples (spec item 3). */
export const TRAINING_APPROVER_ROLES: UserRole[] = ["owner", "admin", "specialist"];

/*
 * Quién puede ver los datos personales de un cliente: nombre, DNI, correo y
 * teléfono.
 *
 * Tiene los mismos tres miembros que TRAINING_APPROVER_ROLES y son constantes
 * separadas a propósito. Aprobar un ejemplo de referencia y leer el padrón
 * de clientes cambian por razones distintas: el día que se decida que un
 * analista puede aprobar ejemplos, eso no debería abrirle el padrón. Unificarlas
 * porque hoy coinciden es exactamente cómo un cambio de producto en una se
 * filtra a la otra sin que nadie lo note.
 */
export const CUSTOMER_PII_ROLES: UserRole[] = ["owner", "admin", "specialist"];

/**
 * Quién da de alta y cambia clientes y pólizas: a mano y por importación (B16).
 * El pedido habla de «admin/editor»; no existe un rol `editor` y no se crea uno:
 * `specialist` es quien edita en esta aplicación. Constante propia, no
 * `CUSTOMER_PII_ROLES`: leer el padrón y escribirlo cambian por razones
 * distintas, y el día que un analista pueda ver datos no debería poder pisarlos.
 */
export const PADRON_EDITOR_ROLES: UserRole[] = ["owner", "admin", "specialist"];

/** Quién entrega un caso al Core. La ruta y el botón leen esta lista: si difieren, el botón da 403. */
export const CORE_SYNC_ROLES: UserRole[] = ["owner", "admin", "specialist"];

/**
 * Quién ve los desvíos de la revisión nocturna (B22): quien maneja al equipo.
 * No hay rol `supervisor`; owner, admin y specialist son los que gestionan.
 * Constante propia por lo mismo que arriba: leer el padrón y revisar la
 * calidad del trabajo cambian por razones distintas.
 */
export const REVISION_ROLES: UserRole[] = ["owner", "admin", "specialist"];

/** Roles with admin-level configuration access. */
export const ADMIN_ROLES: UserRole[] = ["owner", "admin"];

/*
 * Roles allowed to mutate cases / confirm fields (everything except viewer).
 *
 * `viewer` ve todo lo que ve `analyst` —el caso entero, `policyholder_name` y
 * `policy_number` incluidos— y no toca nada. La única lectura que se le niega
 * es la misma que a `analyst`: el padrón (`CUSTOMER_PII_ROLES`). Decidido el
 * 11/09: si algún día «viewer» pasa a ser «no ve datos personales», eso es una
 * proyección por rol en toda la pantalla del caso, no un parche en una ruta.
 */
export const CASE_EDITOR_ROLES: UserRole[] = ["owner", "admin", "specialist", "analyst"];

/** Quién cambia el estado de un caso: un editor; si es analista, sólo uno suyo o sin asignar (decisión 27/09). */
export function puedeCambiarEstado(actor: { role: string; id: string }, assignedTo: string | null): boolean {
  return (CASE_EDITOR_ROLES as readonly string[]).includes(actor.role)
    && (actor.role !== "analyst" || assignedTo === null || assignedTo === actor.id);
}

/** Quién le pasa un caso a otra persona: todo el que edita menos el analista, que sólo maneja los suyos. */
export function asignaATerceros(role: string): boolean {
  return (CASE_EDITOR_ROLES as readonly string[]).includes(role) && role !== "analyst";
}

/**
 * Quién puede pasar un caso de `actual` a `destino` (null = sin asignar).
 *
 * Owner, admin y specialist mueven cualquier caso a cualquiera. Un analista sólo
 * toma un caso libre, se queda con el suyo o lo suelta: no se lo pasa a otro ni
 * le toca uno ajeno. Que el destino exista, sea del mismo inquilino y edite lo
 * decide la base dentro del UPDATE (`guardaDeAsignacion`), no esta función.
 */
export function puedeAsignar(
  actor: { role: string; id: string },
  actual: string | null,
  destino: string | null
): boolean {
  if (asignaATerceros(actor.role)) return true;
  return actor.role === "analyst" && (actual === null || actual === actor.id) && (destino === null || destino === actor.id);
}
