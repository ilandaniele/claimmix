import { sql } from "drizzle-orm";

/**
 * El candado que pone en fila a quienes cambian a los admins de un espacio: baja,
 * alta, rol y borrado de una persona lo toman primero en su lote. Una sola
 * definición, porque si dos escrituras usaran claves distintas dejarían de
 * excluirse y la invariante «al espacio le queda quien lo administre» caería.
 */
export const candadoDeAdmins = (tenantId: string) =>
  sql`select pg_advisory_xact_lock(hashtext('admins'), hashtext(${tenantId}::text))`;
