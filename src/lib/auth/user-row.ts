import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";

export interface UserRow {
  tenant_id: string;
  role: string;
  full_name: string;
  locale: string | null;
}

// `cache()` dedupes per request: layout and page share one query.
export const getUserRow = cache(async (userId: string): Promise<UserRow | null> => {
  try {
    // sin-inquilino: esta consulta AVERIGUA el inquilino de la sesion; no puede pasar por la capa.
    return firstRow(
      await db
        .select({
          tenant_id: users.tenant_id,
          role: users.role,
          full_name: users.full_name,
          locale: users.locale,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    );
  } catch {
    return null;
  }
});
