/**
 * Locale persistence helpers.
 *
 * Locale is stored in a `locale` cookie (SameSite=Lax, no HttpOnly so JS can read it).
 * Default: es-AR.
 */

import { cookies } from "next/headers";
import type { Locale } from "./index";

export const LOCALE_COOKIE = "locale";
export const SUPPORTED_LOCALES: Locale[] = ["es-AR", "en-US"];
export const DEFAULT_LOCALE: Locale = "es-AR";

/** Read the current locale from the request cookie (Server Components only). */
export async function getServerLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const value = cookieStore.get(LOCALE_COOKIE)?.value;
  if (value && (SUPPORTED_LOCALES as string[]).includes(value)) {
    return value as Locale;
  }
  return DEFAULT_LOCALE;
}
