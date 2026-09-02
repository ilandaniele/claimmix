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
 * separadas a propósito. Aprobar un ejemplo de entrenamiento y leer el padrón
 * de clientes cambian por razones distintas: el día que se decida que un
 * analista puede aprobar ejemplos, eso no debería abrirle el padrón. Unificarlas
 * porque hoy coinciden es exactamente cómo un cambio de producto en una se
 * filtra a la otra sin que nadie lo note.
 */
export const CUSTOMER_PII_ROLES: UserRole[] = ["owner", "admin", "specialist"];

/** Roles with admin-level configuration access. */
export const ADMIN_ROLES: UserRole[] = ["owner", "admin"];

/** Roles allowed to mutate cases / confirm fields (everything except viewer). */
export const CASE_EDITOR_ROLES: UserRole[] = ["owner", "admin", "specialist", "analyst"];
