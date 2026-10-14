/**
 * ¿Está prendido el alta con la WABA propia del cliente?
 *
 * Es la bandera `ALTA_WABA_PROPIA`, apagada por omisión, y además hace falta que
 * estén cargadas las tres credenciales de la app de Meta: sin ellas el popup no
 * abre y el canje del código no anda, así que mostrar el botón sería prometer
 * algo que falla. Apagarla frena sólo el alta nueva: lo que ya está conectado
 * sigue enviando, porque el envío nunca mira esta bandera.
 *
 * `appPropia()` es la bandera hermana de la vía «app propia» (el cliente crea su
 * propia app de Meta): `ALTA_APP_PROPIA` más lo que esa vía necesita para hablar con
 * Graph y para guardar el secreto de la app del cliente. Falta algo: cerrada.
 *
 * Vive sola y sin imports de valores a propósito, como `numero-automatico-activo.ts`:
 * la leen el proxy, la bandeja y /configuracion, y sus tests no tienen que mockear
 * `server-only` ni arrastrar la cadena de la base.
 */
import type { OrigenDeWaba } from "@/server/alta/waba-resultados";

const CREDENCIALES = ["META_APP_ID", "META_ES_CONFIG_ID", "WHATSAPP_APP_SECRET"] as const;

export function wabaPropia(): boolean {
  return process.env.ALTA_WABA_PROPIA === "1" && CREDENCIALES.every((nombre) => (process.env[nombre] ?? "").trim() !== "");
}

const CONFIG_DE_APP = ["NEXT_PUBLIC_SITE_URL", "META_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_APP_SECRETS_KEY"] as const;

/** Los nombres (nunca los valores) de lo que falta cargar para la vía «app propia». */
export function faltantesDeAppPropia(): string[] {
  return CONFIG_DE_APP.filter((nombre) => (process.env[nombre] ?? "").trim() === "");
}

export function appPropia(): boolean {
  return process.env.ALTA_APP_PROPIA === "1" && faltantesDeAppPropia().length === 0;
}

/**
 * ¿Rige la vía de esta fila? Una fila viva (ni cancelada ni revocada) la decide su propio
 * origen: la persona sigue con lo que ya empezó aunque la bandera del otro camino esté
 * apagada. Sin fila viva decide la bandera de la acción. Nunca se mira una bandera para
 * «desconectar» ni «cancelar» (S11): soltar lo que ya se tiene no se puede frenar.
 */
export function activaPara(fila: { origen: OrigenDeWaba | null; estado: string | null } | null, banderaDeLaAccion: boolean): boolean {
  if (fila && fila.estado !== null && fila.estado !== "cancelada" && fila.estado !== "revocada") {
    return fila.origen === "app_propia" ? appPropia() : wabaPropia();
  }
  return banderaDeLaAccion;
}

/**
 * La URL pública del webhook de la app de un cliente: una ruta por espacio, que sale del
 * sitio de este ambiente. Null si el sitio no es https: Meta no llama a otra cosa.
 */
export function urlDelWebhookDeApp(ruta: string): string | null {
  const sitio = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (!sitio || !/^https:\/\/[^/\s]/i.test(sitio) || !URL.canParse(sitio)) return null;
  return `${sitio}/api/webhooks/whatsapp/app/${ruta}`;
}
