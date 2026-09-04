// UI text in either language. `users.locale` is per-user state on shared
// staging, so a test must not assume the interface language.
import { esAR } from "../../src/lib/i18n/es-AR";
import { enUS } from "../../src/lib/i18n/en-US";
import type { TranslationKey } from "@/lib/i18n";

function literal(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function enCualquierIdioma(clave: TranslationKey): RegExp {
  const variantes = [...new Set([esAR[clave], enUS[clave]])].map(literal);
  return new RegExp(variantes.join("|"), "i");
}
