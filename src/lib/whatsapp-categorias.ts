/**
 * Los rubros del perfil de empresa de WhatsApp, definidos una sola vez: son los valores de
 * `vertical` de la Cloud API
 * (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles),
 * los mismos que acepta `extras.setup.phone.category` del Embedded Signup. Los usan la
 * pantalla previa al popup, la validación del servidor y el perfil automático de la vía
 * con app propia. Sin `UNDEFINED` ni `NOT_A_BIZ`, que Meta no ofrece.
 *
 * Sin imports: lo usan también los módulos del navegador.
 */

export const CATEGORIAS_DE_PERFIL = [
  "ALCOHOL",
  "APPAREL",
  "AUTO",
  "BEAUTY",
  "EDU",
  "ENTERTAIN",
  "EVENT_PLAN",
  "FINANCE",
  "GOVT",
  "GROCERY",
  "HEALTH",
  "HOTEL",
  "NONPROFIT",
  "ONLINE_GAMBLING",
  "OTC_DRUGS",
  "OTHER",
  "PHYSICAL_GAMBLING",
  "PROF_SERVICES",
  "RESTAURANT",
  "RETAIL",
  "TRAVEL",
] as const;

export type CategoriaDePerfil = (typeof CATEGORIAS_DE_PERFIL)[number];

/** La que sale elegida de entrada: las aseguradoras son el cliente típico. Sólo preselecciona; el cliente elige. */
export const CATEGORIA_INICIAL: CategoriaDePerfil = "FINANCE";

const VALIDAS: ReadonlySet<string> = new Set(CATEGORIAS_DE_PERFIL);

/** La categoría si está en la lista, tal cual y sin recortar ni cambiar mayúsculas; si no, null. */
export function categoriaDePerfil(valor: unknown): CategoriaDePerfil | null {
  return typeof valor === "string" && VALIDAS.has(valor) ? (valor as CategoriaDePerfil) : null;
}
