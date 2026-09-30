import { sql, type SQL } from "drizzle-orm";

import { CANALES_REALES } from "@/lib/schemas/cases";

/**
 * `'whatsapp', 'email', 'web'` para un `in (...)`, escrito de una vez para quien
 * arma SQL a mano. La lista es del código, nunca texto de afuera.
 */
export const CANALES_REALES_SQL: SQL = sql.raw(CANALES_REALES.map((c) => `'${c}'`).join(", "));
