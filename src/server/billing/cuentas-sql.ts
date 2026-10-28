import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { PESO_EN_DECIMAS, type Cubeta } from "@/lib/billing/plans";

/**
 * Qué casos son de cada cubeta del cupo. Con `esCasoReal` por delante las cuatro son
 * disjuntas y cubren `CANALES_REALES`: cada denuncia cae en una sola.
 */
const CONDICION: Record<Cubeta, SQL> = {
  whatsapp: sql`channel = 'whatsapp' and not waba_propia`,
  whatsapp_propia: sql`channel = 'whatsapp' and waba_propia`,
  email: sql`channel = 'email'`,
  web: sql`channel = 'web'`,
};

/**
 * Las denuncias de cada cubeta, para pegar en el select de los conteos del mes:
 * `consumoDelMes` las pesa. Los hechos se cuentan acá y los precios se cobran en
 * `plans.ts`.
 *
 * Los nombres de columna van crudos, como el `is_claim is true` que reemplazan, y
 * sólo son seguros porque las dos consultas que las usan (`statement` y
 * `tenant-summary`) leen de `cases` sin join ni alias: con otra tabla con `channel`
 * se volverían ambiguos.
 */
export const cuentasPorCubeta = Object.fromEntries(
  (Object.keys(PESO_EN_DECIMAS) as Cubeta[]).map((cubeta) => [
    cubeta,
    sql<number>`count(*) filter (where is_claim is true and (${CONDICION[cubeta]}))::int`,
  ])
) as Record<Cubeta, SQL<number>>;
