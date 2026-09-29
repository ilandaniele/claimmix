import type { TranslationKey } from "@/lib/i18n";

const MOTIVOS = new Map<string, TranslationKey>([
  ["timeout", "core.motivo.timeout"],
  ["red", "core.motivo.red"],
  ["destino_rechazado", "core.motivo.destino_rechazado"],
  ["redireccion", "core.motivo.redireccion"],
]);

/**
 * El texto de un código de fallo de la entrega (`core_error_message`, el
 * `motivo` de la prueba). Un código desconocido, como los que dejó el
 * simulador viejo, no se muestra crudo.
 */
export function textoDelMotivo(t: (clave: TranslationKey) => string, motivo: string | null | undefined): string {
  const clave = MOTIVOS.get(motivo ?? "");
  if (clave) return t(clave);
  const http = /^http_(\d{3})$/.exec(motivo ?? "");
  return http ? t("core.motivo.http").replace("{n}", http[1]!) : t("core.motivo.otro");
}
