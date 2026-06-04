/**
 * Locale constants shared between client and server.
 * No server-only imports — safe to import from client components.
 */

import type { Locale } from "./index";

export const LOCALE_COOKIE = "locale";
export const SUPPORTED_LOCALES: Locale[] = ["es-AR", "en-US"];
export const DEFAULT_LOCALE: Locale = "es-AR";
