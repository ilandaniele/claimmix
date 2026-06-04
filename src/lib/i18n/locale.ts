/**
 * Server-only locale helper.
 * Reads the locale from the request cookie (Server Components only).
 *
 * Do NOT import this file from "use client" components — it imports
 * next/headers which is a server-only API. Use locale-shared.ts for
 * constants that are safe to import client-side.
 */

import { cookies } from "next/headers";
import type { Locale } from "./index";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_COOKIE } from "./locale-shared";

// Re-export constants so existing `import { LOCALE_COOKIE } from "@/lib/i18n/locale"` keeps working.
export { LOCALE_COOKIE, SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./locale-shared";

/** Read the current locale from the request cookie (Server Components only). */
export async function getServerLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const value = cookieStore.get(LOCALE_COOKIE)?.value;
  if (value && (SUPPORTED_LOCALES as string[]).includes(value)) {
    return value as Locale;
  }
  return DEFAULT_LOCALE;
}
