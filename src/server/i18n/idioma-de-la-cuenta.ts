import "server-only";
import { cache } from "react";

import { getSessionContext } from "@/lib/auth/session";
import { getUserRow } from "@/lib/auth/user-row";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import type { Locale } from "@/lib/i18n";

/**
 * El idioma de una pantalla del shell (app)/: la preferencia de la cuenta le
 * gana a la cookie del dispositivo. Mismo lookup de sesión + fila de usuario
 * que hace `(app)/layout.tsx`, envuelto en `cache()` — layout y página piden
 * lo mismo en el mismo pedido y comparten una sola consulta.
 */
export const getAccountLocale = cache(async (): Promise<Locale> => {
  const session = await getSessionContext();
  const userId = session?.user?.id;
  const userRow = userId ? await getUserRow(userId) : null;
  return resolveAccountLocale(userRow?.locale);
});
