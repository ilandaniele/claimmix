/**
 * Lo que /conectar-whatsapp hace en el navegador con el SDK de Facebook y el popup del
 * Embedded Signup de Meta.
 *
 * Nada de lo que cuenta el popup es de fiar: el servidor saca los ids del token que
 * canjea el código, y lo de acá son pistas. Aun así, el `message` se acepta sólo de
 * los orígenes de Meta, sólo mientras hay un popup abierto por nosotros, y se lee sin
 * confiar en la forma: cualquier otra cosa es ruido y se ignora.
 */

import { ID_DE_META } from "@/lib/meta-ids";
import { pasoCancelado, type PasoCancelado } from "@/server/alta/waba-resultados";

/** Los dominios desde los que el popup manda su `postMessage`. Ni un `endsWith`: `evil-facebook.com` no entra. */
export const ORIGENES_DE_META: readonly string[] = [
  "https://www.facebook.com",
  "https://web.facebook.com",
  "https://business.facebook.com",
];

const EVENTO = /^[A-Z_]{1,60}$/;

export type EventoDeMeta =
  | { tipo: "fin"; evento: string; wabaId?: string; phoneNumberId?: string }
  | { tipo: "cancelo"; paso: PasoCancelado; codigo?: number };

const texto = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const idDeMeta = (v: unknown): string | undefined => (typeof v === "string" && ID_DE_META.test(v) ? v : undefined);

/** El código de error de Meta, que llega como número o como texto con dígitos. */
function codigoDeError(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Un `message` del navegador convertido en lo que importa del Embedded Signup, o null.
 * El JSON se parsea adentro de un try: un mensaje que no es JSON (los hay de todo tipo
 * circulando entre ventanas) no puede romper el manejador.
 */
export function leerEventoDeMeta(origen: string, datos: unknown): EventoDeMeta | null {
  if (!ORIGENES_DE_META.includes(origen)) return null;
  let cuerpo: unknown = datos;
  if (typeof datos === "string") {
    try {
      cuerpo = JSON.parse(datos);
    } catch {
      return null;
    }
  }
  if (!cuerpo || typeof cuerpo !== "object") return null;
  const m = cuerpo as { type?: unknown; event?: unknown; data?: unknown };
  if (m.type !== "WA_EMBEDDED_SIGNUP") return null;
  const evento = texto(m.event);
  if (!evento || !EVENTO.test(evento)) return null;
  const d = m.data && typeof m.data === "object" ? (m.data as Record<string, unknown>) : {};

  if (evento.startsWith("FINISH")) {
    return { tipo: "fin", evento, wabaId: idDeMeta(d.waba_id), phoneNumberId: idDeMeta(d.phone_number_id) };
  }
  if (evento === "CANCEL" || evento === "ERROR") {
    return { tipo: "cancelo", paso: pasoCancelado(d.current_step), codigo: codigoDeError(d.error_code) };
  }
  return null;
}

interface RespuestaDeLogin {
  authResponse?: { code?: string; userID?: string } | null;
}

/** Lo poco del SDK que se usa. */
export interface SdkDeFacebook {
  init(opciones: { appId: string; version: string; xfbml: boolean; autoLogAppEvents: boolean }): void;
  login(alTerminar: (respuesta: RespuestaDeLogin) => void, opciones: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: SdkDeFacebook;
    fbAsyncInit?: () => void;
  }
}

const TIEMPO_DEL_SDK_MS = 10_000;
let cargando: Promise<SdkDeFacebook> | null = null;

/**
 * Carga el SDK una sola vez. Se inyecta desde nuestro propio código (que la CSP deja
 * pasar con `strict-dynamic`) y no en el HTML, para que un bloqueador que lo corta no
 * rompa la página: la promesa rechaza y el panel avisa. Si falla, el próximo intento
 * arranca de cero.
 */
export function cargarSdk(p: { appId: string; version: string; idioma: "es_LA" | "en_US" }): Promise<SdkDeFacebook> {
  if (cargando) return cargando;
  cargando = new Promise<SdkDeFacebook>((resolver, rechazar) => {
    const script = document.createElement("script");
    const fallar = (motivo: string) => {
      clearTimeout(plazo);
      script.remove();
      window.fbAsyncInit = undefined;
      cargando = null;
      rechazar(new Error(motivo));
    };
    const plazo = setTimeout(() => fallar("sdk_timeout"), TIEMPO_DEL_SDK_MS);
    window.fbAsyncInit = () => {
      const fb = window.FB;
      if (!fb) return fallar("sdk_vacio");
      fb.init({ appId: p.appId, version: p.version, xfbml: false, autoLogAppEvents: false });
      clearTimeout(plazo);
      resolver(fb);
    };
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = `https://connect.facebook.net/${p.idioma}/sdk.js`;
    script.onerror = () => fallar("sdk_bloqueado");
    document.head.appendChild(script);
  });
  return cargando;
}

/** Lo que dejó el popup: el código con las pistas, o el paso en el que se cerró. */
export type SalidaDelPopup =
  | { tipo: "codigo"; code: string; evento?: string; wabaId?: string; phoneNumberId?: string; userId?: string }
  | { tipo: "cancelo"; paso: PasoCancelado; codigo?: number };

/** Lo que se espera el evento después del código (o del cierre): el código vive 30 s, esto es una fracción. */
export const ESPERA_DEL_EVENTO_MS = 3000;

/**
 * Abre el popup y junta sus dos señales. El `FB.login` va primero y síncrono porque el
 * navegador sólo deja abrir una ventana dentro del clic; el orden en que llegan el
 * `message` y el callback no está garantizado, y el código vale 30 segundos, así que
 * cuando llega uno se espera un rato corto al otro y se sigue con lo que haya. El
 * oyente vive mientras dura el popup y se va con la promesa.
 */
export function abrirRegistro(p: {
  fb: SdkDeFacebook;
  configId: string;
  setup: object | undefined;
  esperaMs?: number;
}): Promise<SalidaDelPopup> {
  return new Promise((resolver) => {
    let codigo: string | null = null;
    let userId: string | undefined;
    let fin: Extract<EventoDeMeta, { tipo: "fin" }> | null = null;
    let cancelo: Extract<EventoDeMeta, { tipo: "cancelo" }> | null = null;
    let respondio = false;
    let hecho = false;
    let espera: ReturnType<typeof setTimeout> | null = null;

    const terminar = (salida: SalidaDelPopup) => {
      hecho = true;
      if (espera) clearTimeout(espera);
      window.removeEventListener("message", alMensaje);
      resolver(salida);
    };

    const evaluar = (vencio: boolean) => {
      if (hecho) return;
      if (cancelo) return terminar(cancelo);
      if (codigo && (fin || vencio)) {
        return terminar({
          tipo: "codigo",
          code: codigo,
          evento: fin?.evento,
          wabaId: fin?.wabaId,
          phoneNumberId: fin?.phoneNumberId,
          userId,
        });
      }
      if (respondio && !codigo && vencio) return terminar({ tipo: "cancelo", paso: "otro" });
      if ((codigo || respondio) && !espera) espera = setTimeout(() => evaluar(true), p.esperaMs ?? ESPERA_DEL_EVENTO_MS);
    };

    function alMensaje(e: MessageEvent) {
      const evento = leerEventoDeMeta(e.origin, e.data);
      if (!evento || hecho) return;
      if (evento.tipo === "fin") fin = evento;
      else cancelo = evento;
      evaluar(false);
    }

    window.addEventListener("message", alMensaje);
    p.fb.login(
      (respuesta) => {
        respondio = true;
        codigo = typeof respuesta?.authResponse?.code === "string" ? respuesta.authResponse.code : null;
        userId = idDeMeta(respuesta?.authResponse?.userID);
        evaluar(false);
      },
      {
        config_id: p.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: p.setup ?? {} },
      }
    );
  });
}
