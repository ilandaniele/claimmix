/**
 * El cliente de Graph del alta propia: lo que se le pide a Meta después de que
 * el cliente terminó el Embedded Signup y nos llegó su código.
 *
 * Es sólo el cliente. No decide nada (qué hacer con cada respuesta, cuánto cupo
 * queda y qué se guarda lo resuelve el orquestador), no toca la base y no lee los
 * ids de la plataforma del .env: la WABA y el número de la plataforma salen de
 * `numeros.ts`, que es el único que los lee. Eso sirve de freno: ninguna
 * función de acá opera sobre la WABA ni sobre el número de la plataforma.
 *
 * Todo vuelve como `RespuestaDeAlta`, igual que `alta-de-numero.ts`, y se
 * clasifica con la misma `clasificar`. Dos reglas de seguridad que los tests fijan:
 *
 *   - Un secreto no viaja en una URL. El token del cliente va en la cabecera
 *     `Authorization`; el `client_secret`, el `code` y el `input_token` van en
 *     el cuerpo de un POST. Una URL con consulta termina en logs de
 *     proxies y en breadcrumbs de Sentry.
 *   - De un error sólo queda `{paso, status, codigo}`. Ni el token, ni el
 *     código, ni el cuerpo de lo que Meta contestó se anotan.
 */

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { CUERPO_REABRIR, PLANTILLA_REABRIR } from "@/core/mensajes/reabrir-denuncia";
import { ID_DE_USUARIO_DE_META } from "@/lib/meta-ids";
import { TOKEN_INVALIDO } from "@/server/whatsapp/errores-de-graph";
import { clienteDeGraph, objeto, SIN_PEDIDO, texto, type Falla, type RespuestaDeAlta } from "@/server/whatsapp/graph";
import { idDeLaPlataforma, wabaDeLaPlataforma } from "@/server/whatsapp/numeros";
import { ID_DE_GRAPH } from "@/server/whatsapp/verificar-en-meta";

type Paso = "canje" | "revisar" | "negocio" | "suscribir" | "desuscribir" | "datos_numero" | "plantilla" | "baja";

export const PERMISOS_DE_WHATSAPP = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;

/** «Ya existe una plantilla con ese nombre e idioma»: error 100 con este subcódigo. */
const SUBCODIGO_PLANTILLA_EXISTENTE = 2388024;

/** `oauth/access_token` contesta 100 con estos subcódigos cuando el código del popup venció (36007) o ya se usó (36009). */
const CODIGO_DEL_CANJE = 100;
const SUBCODIGOS_DE_CODIGO_VENCIDO: readonly number[] = [36007, 36009];

/** Lo que sale en un token de texto plano: sin espacios ni nada que rompa una cabecera. */
const TOKEN_DE_TEXTO = /^[\w|.-]{10,1024}$/;
const CODIGO_MAXIMO = 1024;

function credencialesDeApp(): { appId: string; configId: string; secreto: string } | null {
  const appId = process.env.META_APP_ID?.trim();
  const configId = process.env.META_ES_CONFIG_ID?.trim();
  const secreto = process.env.WHATSAPP_APP_SECRET?.trim();
  return appId && configId && secreto ? { appId, configId, secreto } : null;
}

/** La app de Meta y la configuración del popup, para el navegador. El secreto nunca sale de acá. */
export function appDeMeta(): { appId: string; configId: string } | null {
  const app = credencialesDeApp();
  return app ? { appId: app.appId, configId: app.configId } : null;
}

const { respuestaRara, rechazada, llamar, confirmada } = clienteDeGraph<Paso>("whatsapp.embedded_signup.graph");

/** Un id que va en la URL: sólo dígitos, y nunca la WABA de la plataforma. */
const wabaValida = (id: string) => ID_DE_GRAPH.test(id) && id !== wabaDeLaPlataforma();
/** Un id que va en la URL: sólo dígitos, y nunca el número de la plataforma. */
const numeroValido = (id: string) => ID_DE_GRAPH.test(id) && id !== idDeLaPlataforma();

/** Una falla del canje con el subcódigo de Graph: es lo único que separa un código vencido de una app mal configurada. */
export type FallaDelCanje = Falla & { subcodigo: number | null };

export type RespuestaDelCanje = { ok: true; valor: { token: string } } | FallaDelCanje;

/** El código del popup ya no sirve (venció o ya se usó): volver a abrir la ventana lo arregla. Cualquier otro rechazo no. */
export function codigoVencido(f: { codigo: number | null; subcodigo: number | null }): boolean {
  return f.codigo === CODIGO_DEL_CANJE && f.subcodigo !== null && SUBCODIGOS_DE_CODIGO_VENCIDO.includes(f.subcodigo);
}

/**
 * Cambia el código del popup por el token del cliente: un usuario de sistema de su
 * negocio, que no vence y muere cuando el cliente saca la app. El código se usa una
 * sola vez y dura minutos; si venció, Graph contesta un rechazo (400, código 100,
 * subcódigo 36007; 36009 si ya se usó).
 */
export async function canjearCodigo(code: string): Promise<RespuestaDelCanje> {
  const app = credencialesDeApp();
  if (!app || typeof code !== "string" || !code || code.length > CODIGO_MAXIMO) return { ...SIN_PEDIDO, subcodigo: null };
  const r = await llamar("canje", "oauth/access_token", {
    metodo: "POST",
    formulario: { client_id: app.appId, client_secret: app.secreto, code },
    puedeSerTexto: true,
  });
  if (!r.ok) return { ...r.falla, subcodigo: r.falla.subcodigo ?? null };
  const token = texto(objeto(r.cuerpo)?.access_token) ?? (typeof r.cuerpo === "string" && TOKEN_DE_TEXTO.test(r.cuerpo) ? r.cuerpo : null);
  return token ? { ok: true, valor: { token } } : { ...respuestaRara("canje"), subcodigo: null };
}

/** Lo que `debug_token` dice de un token, sin decidir nada: cada llamador aplica sus reglas. */
export interface LecturaDeToken {
  valido: boolean;
  /** El `app_id` que Meta informó, o `null` si no vino como texto. */
  appId: string | null;
  /** El `app_id` informado es el de la app que se pasó a `leerDebugToken`. */
  deLaApp: boolean;
  /** El `user_id` de la respuesta: el usuario del sistema dueño del token. */
  usuarioId: string | null;
  /** `expires_at`: 0 es un token sin vencimiento. `null` si no vino como número. */
  expira: number | null;
  /** Permiso a los ids que cubre, de `granular_scopes` y de `scopes`; `null` si Meta no informó `target_ids` (vale para todos los activos). */
  alcances: Map<string, string[] | null>;
}

/** El cuerpo de `debug_token` ya leído. `null` si no trae `data.is_valid`: una respuesta que no se interpreta. */
export function leerDebugToken(json: unknown, appId: string): LecturaDeToken | null {
  const datos = objeto(objeto(json)?.data);
  if (!datos || typeof datos.is_valid !== "boolean") return null;
  const alcances = new Map<string, string[] | null>();
  for (const g of Array.isArray(datos.granular_scopes) ? datos.granular_scopes : []) {
    const permiso = texto(objeto(g)?.scope);
    if (!permiso) continue;
    const objetivos = objeto(g)?.target_ids;
    alcances.set(
      permiso,
      Array.isArray(objetivos) ? objetivos.filter((id): id is string => typeof id === "string" && ID_DE_GRAPH.test(id)) : null
    );
  }
  // Un permiso que sólo figura en `scopes` no dice a qué ids vale: queda en null, nunca en una lista.
  for (const s of Array.isArray(datos.scopes) ? datos.scopes : []) {
    const permiso = texto(s);
    if (permiso && !alcances.has(permiso)) alcances.set(permiso, null);
  }
  return {
    valido: datos.is_valid,
    appId: texto(datos.app_id),
    deLaApp: datos.app_id === appId,
    usuarioId: texto(datos.user_id),
    expira: typeof datos.expires_at === "number" ? datos.expires_at : null,
    alcances,
  };
}

/**
 * Lo que el token realmente es, según Meta y no según el navegador: de nuestra app,
 * válido, sin vencimiento, con los dos permisos de WhatsApp. `wabaIds` son las WABA
 * que el cliente compartió, sólo las que figuran en los dos permisos.
 *
 * Un token que Meta dice inválido (`is_valid: false`) da rechazo con código 190, el
 * mismo que da una llamada con un token muerto: quien decide revocar la cuenta lee ese
 * código. Los demás incumplimientos dan rechazo sin código, y un 190 de Graph a la
 * revisión misma (la credencial de la app) también sale sin código.
 */
export async function revisarToken(token: string): Promise<RespuestaDeAlta<{ wabaIds: string[]; fbUserId: string | null }>> {
  const app = credencialesDeApp();
  if (!app || !token) return SIN_PEDIDO;
  const r = await llamar("revisar", "debug_token", {
    metodo: "POST",
    autorizacion: `Bearer ${app.appId}|${app.secreto}`,
    formulario: { input_token: token, method: "GET" },
  });
  // Un 190 acá es de nuestra app (secreto mal puesto o rotado), no del token que se pregunta: sin borrar el código, quien llama daría por muertos los tokens de todos los clientes.
  if (!r.ok) return r.falla.codigo === TOKEN_INVALIDO ? { ...r.falla, codigo: null } : r.falla;

  const lectura = leerDebugToken(r.cuerpo, app.appId);
  if (!lectura) return respuestaRara("revisar");
  if (!lectura.valido) return rechazada("revisar", TOKEN_INVALIDO);
  if (!lectura.deLaApp || lectura.expira !== 0) return rechazada("revisar", null);

  // Sin `target_ids` el permiso no dice qué WABA cubre: acá se exige, para no dar por compartida una que no se vio.
  const [gestion, mensajes] = PERMISOS_DE_WHATSAPP.map((p) => lectura.alcances.get(p));
  if (!gestion || !mensajes) return rechazada("revisar", null);

  return {
    ok: true,
    valor: { wabaIds: [...new Set(gestion)].filter((id) => mensajes.includes(id)), fbUserId: lectura.usuarioId },
  };
}

/**
 * El negocio (portfolio de Meta) dueño de la WABA, según Graph: es lo que cuenta el
 * cupo semanal, y lo que el navegador diga no vale. `null` si Graph no lo informa.
 */
export async function negocioDeLaWaba(token: string, wabaId: string): Promise<RespuestaDeAlta<string | null>> {
  if (!wabaValida(wabaId)) return SIN_PEDIDO;
  const r = await llamar("negocio", `${wabaId}?fields=owner_business_info`, {
    metodo: "GET",
    autorizacion: `Bearer ${token}`,
  });
  if (!r.ok) return r.falla;
  const id = texto(objeto(objeto(r.cuerpo)?.owner_business_info)?.id);
  return { ok: true, valor: id && ID_DE_GRAPH.test(id) ? id : null };
}

/** Suscribe nuestra app a la WABA del cliente: sin esto no llega ningún webhook de ella. */
export async function suscribirApp(token: string, wabaId: string, prueba?: string): Promise<RespuestaDeAlta<true>> {
  if (!wabaValida(wabaId)) return SIN_PEDIDO;
  return confirmada("suscribir", `${wabaId}/subscribed_apps`, { metodo: "POST", autorizacion: `Bearer ${token}`, prueba });
}

/** Saca nuestra app de la WABA del cliente. Graph documenta que DELETE no existe, y anda. */
export async function desuscribirApp(token: string, wabaId: string, prueba?: string): Promise<RespuestaDeAlta<true>> {
  if (!wabaValida(wabaId)) return SIN_PEDIDO;
  return confirmada("desuscribir", `${wabaId}/subscribed_apps`, { metodo: "DELETE", autorizacion: `Bearer ${token}`, prueba });
}

export interface DatosDelNumero {
  display: string;
  nombre: string | null;
  verificado: boolean;
  nombreEstado: string | null;
  /** El número sigue en la app de WhatsApp Business del cliente (coexistencia): no se registra. */
  enLaApp: boolean;
}

const CAMPOS_DEL_NUMERO = "display_phone_number,verified_name,code_verification_status,name_status";

/**
 * Si Graph rechaza `is_on_biz_app` (error 100: el campo no figura confirmado en la
 * documentación del nodo del número) se vuelve a pedir sin él: que el campo no exista
 * no puede tumbar la lectura del número, sólo deja la coexistencia sin detectar acá
 * (la dice también el evento del popup).
 */
export async function datosDelNumero(token: string, id: string, prueba?: string): Promise<RespuestaDeAlta<DatosDelNumero>> {
  if (!numeroValido(id)) return SIN_PEDIDO;
  const pedir = (campos: string) =>
    llamar("datos_numero", `${id}?fields=${campos}`, { metodo: "GET", autorizacion: `Bearer ${token}`, prueba });
  let r = await pedir(`${CAMPOS_DEL_NUMERO},is_on_biz_app`);
  if (!r.ok && r.falla.codigo === 100) r = await pedir(CAMPOS_DEL_NUMERO);
  if (!r.ok) return r.falla;
  const datos = objeto(r.cuerpo);
  const display = texto(datos?.display_phone_number);
  if (!datos || !display) return respuestaRara("datos_numero");
  return {
    ok: true,
    valor: {
      display,
      nombre: texto(datos.verified_name),
      verificado: datos.code_verification_status === "VERIFIED",
      nombreEstado: texto(datos.name_status),
      enLaApp: datos.is_on_biz_app === true,
    },
  };
}

/**
 * Crea `reabrir_denuncia` en la WABA del cliente: cada WABA aprueba sus plantillas,
 * y sin ella no se puede escribir fuera de las 24 h. Que ya exista cuenta como hecho.
 * La categoría la puede cambiar Meta; la aprobación se lee después, en vivo.
 */
export async function crearPlantillaReabrir(token: string, wabaId: string, prueba?: string): Promise<RespuestaDeAlta<true>> {
  if (!wabaValida(wabaId)) return SIN_PEDIDO;
  const r = await llamar("plantilla", `${wabaId}/message_templates`, {
    metodo: "POST",
    autorizacion: `Bearer ${token}`,
    prueba,
    json: {
      name: PLANTILLA_REABRIR.nombre,
      language: PLANTILLA_REABRIR.idioma,
      category: "UTILITY",
      components: [{ type: "BODY", text: CUERPO_REABRIR, example: { body_text: [["ABC-123", "las fotos del choque"]] } }],
    },
  });
  if (!r.ok) {
    // Sólo el subcódigo de «ya existe» separa este 100 de cualquier otro rechazo.
    return r.falla.codigo === 100 && r.falla.subcodigo === SUBCODIGO_PLANTILLA_EXISTENTE ? { ok: true, valor: true } : r.falla;
  }
  return texto(objeto(r.cuerpo)?.id) ? { ok: true, valor: true } : respuestaRara("plantilla");
}

/**
 * Da de baja el número de Cloud API. No lo borra de la WABA ni toca su historial, y no
 * sirve con un número en coexistencia.
 */
export async function bajaDelNumero(token: string, id: string, prueba?: string): Promise<RespuestaDeAlta<true>> {
  if (!numeroValido(id)) return SIN_PEDIDO;
  return confirmada("baja", `${id}/deregister`, { metodo: "POST", autorizacion: `Bearer ${token}`, prueba });
}

/**
 * El `signed_request` con el que Meta pide borrar los datos de una persona: la firma
 * HMAC-SHA256 del payload con el secreto de la app, un punto y el payload, los dos
 * en base64url. Devuelve la persona sólo si la firma es válida; cualquier otra cosa,
 * un payload roto o un algoritmo distinto, es null.
 */
export function leerPedidoFirmado(valor: string): { userId: string } | null {
  const secreto = credencialesDeApp()?.secreto;
  if (!secreto || typeof valor !== "string") return null;
  const partes = valor.split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;

  const firma = Buffer.from(partes[0], "base64url");
  const esperada = createHmac("sha256", secreto).update(partes[1]).digest();
  if (firma.length !== esperada.length || !timingSafeEqual(firma, esperada)) return null;

  try {
    const payload = objeto(JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")));
    if (String(payload?.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    const userId = payload?.user_id;
    return typeof userId === "string" && ID_DE_USUARIO_DE_META.test(userId) ? { userId } : null;
  } catch {
    return null;
  }
}
