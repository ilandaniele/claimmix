import type { ClaveDelCliente } from "@/lib/i18n";

/** «1 sesiones» no se dice: con una sola hay frase propia. */
export function textoDeSesionesCerradas(t: (clave: ClaveDelCliente) => string, n: number): string {
  return n === 1 ? t("usuarios.toast.sesionCerrada") : t("usuarios.toast.sesionesCerradas").replace("{n}", String(n));
}
