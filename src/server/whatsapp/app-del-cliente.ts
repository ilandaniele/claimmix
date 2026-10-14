/**
 * El cliente de Graph de la app propia de un cliente: lo que se le pregunta a
 * Meta con el App ID y el App Secret que el cliente nos pegó, y con el token de
 * usuario del sistema de su cuenta. Es la vía que no usa Embedded Signup
 * (`embedded-signup.ts`).
 *
 * Es sólo el cliente. No decide nada (qué hacer con cada respuesta lo resuelve el
 * orquestador), no toca la base y no lee el .env. Todo vuelve como
 * `RespuestaDeAlta`, igual que `alta-de-numero.ts`, y se clasifica con la misma
 * `clasificar`. Reglas de seguridad que los tests fijan:
 *
 *   - Nada llega a una cabecera, a una URL ni a un log sin pasar su formato antes
 *     (S10): el App ID y los ids de Graph son dígitos, el secreto es ASCII visible
 *     y el token no tiene más que letras, números y `._-`.
 *   - El app token (`{app-id}|{app-secret}`) y el token del cliente viajan sólo en
 *     `Authorization`. La única excepción es `input_token` de `debug_token`, que
 *     lleva el token del cliente en la consulta, como pide la referencia (R25);
 *     `sinConsultaDeMeta` la saca de Sentry y de los logs.
 *   - Los datos van en cuerpos POST. El `appsecret_proof` del token del cliente va
 *     en el cuerpo de los POST y en la consulta de los GET (Q24): sin el token no
 *     sirve, y es la forma que Meta documenta. Las llamadas con el app token no lo
 *     llevan: el app token ya es la prueba de conocer el secreto.
 *   - De un error sólo queda `{paso, status, codigo}`. Ni el token, ni el secreto,
 *     ni el cuerpo de lo que Meta contestó se anotan.
 *
 * Nada de acá opera sobre la WABA ni sobre el número de la plataforma: los ids
 * que se piden son los del cliente, y los de la plataforma se rechazan.
 */

import "server-only";
import { ID_DE_META } from "@/lib/meta-ids";
import { categoriaDePerfil } from "@/lib/whatsapp-categorias";
import type { CredencialDeAlta } from "@/server/whatsapp/alta-de-numero";
import { leerDebugToken, PERMISOS_DE_WHATSAPP } from "@/server/whatsapp/embedded-signup";
import { motivoDeAlta, PARAMETRO_INVALIDO } from "@/server/whatsapp/errores-de-graph";
import {
  clienteDeGraph,
  objeto,
  SIN_PEDIDO,
  texto,
  type FallaDeGraph,
  type Pedido,
  type RespuestaDeAlta,
} from "@/server/whatsapp/graph";
import { idDeLaPlataforma, wabaDeLaPlataforma } from "@/server/whatsapp/numeros";

export interface AppDelCliente {
  appId: string;
  secreto: string;
}

/** Meta no documenta el formato del App Secret: la regla sólo impide lo que rompería una cabecera. */
export const FORMATO_SECRETO = /^[\x21-\x7E]{1,128}$/;
/** El token de un usuario del sistema: letras, números y `._-`. */
export const FORMATO_TOKEN = /^[A-Za-z0-9._-]{1,2048}$/;
/** El `appsecret_proof`: un HMAC-SHA256 en hexadecimal. */
const FORMATO_PRUEBA = /^[0-9a-f]{64}$/;

/** Saca sólo el espacio de los bordes. Un valor con espacios o caracteres de control adentro se rechaza, no se limpia. */
export const recortar = (v: string): string => v.trim();

/** Un App Secret nunca empieza con «EAA» ni lleva «|»: eso es un token de acceso. Heurística sin fuente. */
export function pareceToken(v: string): boolean {
  return v.startsWith("EAA") || v.includes("|");
}

export { pruebaDelSecreto } from "@/server/whatsapp/sobres-del-cliente";

type Paso =
  | "leer_app"
  | "suscribir_webhook"
  | "leer_datos"
  | "fijar_datos"
  | "revisar_token"
  | "salud"
  | "estado_nombre"
  | "pedir_nombre"
  | "perfil_leer"
  | "perfil_escribir";

const { respuestaRara, pedirObjeto: llamar, confirmada } = clienteDeGraph<Paso>("whatsapp.app_del_cliente.graph");

const appValida = (app: AppDelCliente) => ID_DE_META.test(app.appId) && FORMATO_SECRETO.test(app.secreto);
const delApp = (app: AppDelCliente) => `Bearer ${app.appId}|${app.secreto}`;

/** Un id que va en la URL: sólo dígitos, y nunca el de la WABA ni el del número de la plataforma. */
const nodoValido = (id: string) => ID_DE_META.test(id) && id !== idDeLaPlataforma() && id !== wabaDeLaPlataforma();

const credencialValida = (cred: CredencialDeAlta) =>
  FORMATO_TOKEN.test(cred.accessToken) &&
  nodoValido(cred.wabaId) &&
  (cred.prueba === undefined || FORMATO_PRUEBA.test(cred.prueba));
const delCliente = (cred: CredencialDeAlta): Pedido => ({ autorizacion: `Bearer ${cred.accessToken}`, prueba: cred.prueba });

/** Una URL https con host, sin usuario ni clave, de a lo sumo `largo` caracteres. */
function urlHttps(v: string, largo: number): boolean {
  if (v.length > largo) return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const CORREO = /^[^\s@]{1,64}@[^\s@]{1,128}$/;
const OBJETO_DE_WHATSAPP = "whatsapp_business_account";

export type EstadoDelCallback = "nuestro" | "ajeno" | "ninguno" | "desconocido";

/** `true` sólo si W6 confirma que el GET de `/subscriptions` lista el objeto de WhatsApp (I1). Hasta entonces, sin él, el callback es «desconocido». */
export const GET_LISTA_WHATSAPP = false;

/**
 * El callback de WhatsApp de la app, según `GET /{app-id}/subscriptions`:
 * - listado, con `callback_url` igual a `nuestraUrl`: `nuestro`; con otra: `ajeno`;
 * - sin listar: `ninguno` si `GET_LISTA_WHATSAPP`, `desconocido` si no.
 * Un 4xx que no es de espera (el secreto mal puesto) vuelve como rechazo: quien llama lo lee como `app_invalida`.
 */
export async function leerApp(app: AppDelCliente, nuestraUrl: string): Promise<RespuestaDeAlta<EstadoDelCallback>> {
  if (!appValida(app)) return SIN_PEDIDO;
  const r = await llamar("leer_app", `${app.appId}/subscriptions`, { autorizacion: delApp(app) });
  if (!r.ok) return r;
  if (!Array.isArray(r.valor.data)) return respuestaRara("leer_app");
  const suscripcion = r.valor.data.map(objeto).find((s) => s?.object === OBJETO_DE_WHATSAPP);
  if (!suscripcion) return { ok: true, valor: GET_LISTA_WHATSAPP ? "ninguno" : "desconocido" };
  const url = texto(suscripcion.callback_url);
  if (!url) return { ok: true, valor: "desconocido" };
  return { ok: true, valor: url === nuestraUrl ? "nuestro" : "ajeno" };
}

/** Los cuatro campos de E14. El estado de la plantilla se lee en vivo y el cupo de números no se usa. */
export const CAMPOS_DEL_WEBHOOK = ["messages", "account_update", "account_review_update", "phone_number_name_update"] as const;

const VERIFY_TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const CAMPO_DE_WEBHOOK = /^[a-z_]{1,64}$/;

/**
 * Configura el callback de WhatsApp de la app por API. La referencia de `/subscriptions` lista user, page,
 * permissions y payments, y la guía lo llama «método alternativo» (I1): sólo se llama cuando `leerApp` dio `ninguno`.
 * Meta pide el `verify_token` al callback en el momento de guardarlo.
 */
export async function suscribirWebhookDeApp(
  app: AppDelCliente,
  callbackUrl: string,
  verifyToken: string,
  campos: readonly string[]
): Promise<RespuestaDeAlta<true>> {
  if (!appValida(app) || !urlHttps(callbackUrl, 512) || !VERIFY_TOKEN.test(verifyToken)) return SIN_PEDIDO;
  if (campos.length === 0 || !campos.every((c) => CAMPO_DE_WEBHOOK.test(c))) return SIN_PEDIDO;
  return confirmada("suscribir_webhook", `${app.appId}/subscriptions`, {
    autorizacion: delApp(app),
    formulario: {
      object: OBJETO_DE_WHATSAPP,
      callback_url: callbackUrl,
      verify_token: verifyToken,
      fields: campos.join(","),
    },
  });
}

export interface DatosDeLaApp {
  terminos: string | null;
  privacidad: string | null;
  contacto: string | null;
}

/** Los datos legales de la app, vacíos como `null`. Que el app token los lea es la incógnita I37. */
export async function leerDatosDeLaApp(app: AppDelCliente): Promise<RespuestaDeAlta<DatosDeLaApp>> {
  if (!appValida(app)) return SIN_PEDIDO;
  const r = await llamar("leer_datos", `${app.appId}?fields=terms_of_service_url,privacy_policy_url,contact_email`, {
    autorizacion: delApp(app),
  });
  if (!r.ok) return r;
  return {
    ok: true,
    valor: {
      terminos: texto(r.valor.terms_of_service_url),
      privacidad: texto(r.valor.privacy_policy_url),
      contacto: texto(r.valor.contact_email),
    },
  };
}

/**
 * Escribe en la app sólo los datos legales que se pasen (quien llama manda los que `leerDatosDeLaApp`
 * devolvió vacíos). Sin ninguno no se llama a Graph.
 */
export async function fijarDatosDeLaApp(
  app: AppDelCliente,
  datos: { terminos?: string; privacidad?: string; contacto?: string }
): Promise<RespuestaDeAlta<true>> {
  if (!appValida(app)) return SIN_PEDIDO;
  const formulario: Record<string, string> = {};
  if (datos.terminos !== undefined) {
    if (!urlHttps(datos.terminos, 2048)) return SIN_PEDIDO;
    formulario.terms_of_service_url = datos.terminos;
  }
  if (datos.privacidad !== undefined) {
    if (!urlHttps(datos.privacidad, 2048)) return SIN_PEDIDO;
    formulario.privacy_policy_url = datos.privacidad;
  }
  if (datos.contacto !== undefined) {
    if (!CORREO.test(datos.contacto)) return SIN_PEDIDO;
    formulario.contact_email = datos.contacto;
  }
  if (Object.keys(formulario).length === 0) return { ok: true, valor: true };
  return confirmada("fijar_datos", app.appId, { autorizacion: delApp(app), formulario });
}

export type RevisionDeToken =
  | { ok: true; usuarioId: string | null; wabaIds: string[] | null } // wabaIds null: Meta no informó target_ids (I3)
  | { ok: false; motivo: "token_vencido" | "token_de_otra_app" | "token_temporal" | "app_invalida" }
  | { ok: false; motivo: "falta_permiso"; permiso: string }
  | { ok: false; motivo: "permisos_de_mas"; permisos: string[] }
  | { ok: false; motivo: FallaDeGraph; codigo: number | null };

/**
 * Alcances que Meta puede sumar al token aunque el cliente no los haya marcado (I33). Se llena
 * con lo que W6 vea en un token real, cada uno con su fuente; hasta entonces no se tolera ninguno.
 */
const PERMISOS_TOLERADOS: readonly string[] = [];

/** Más que esto no se devuelve: el cliente ve la lista, y la manda Meta. */
const PERMISOS_MAXIMOS = 20;

type FallaDeLaRevision = Extract<RevisionDeToken, { ok: false }>;

/**
 * Un 4xx de `debug_token` no dice por sí solo qué falló. Por el código (`motivoDeAlta("revisar")`) se separa lo que es
 * del token (463 y 467) y lo que es de espera; el resto (la autenticación, el 100, un rechazo sin código) puede ser el
 * secreto cambiado o no, y sólo la propia app lo dice: si `leerApp` también la rechaza es `app_invalida`. Si la acepta
 * el secreto está bien: el 100 es el «App_id in the input_token did not match the Viewing App» de Graph, o sea un
 * token de otra app, y lo demás se deja en `meta` en vez de mandar a la persona a reescribir un secreto que anda.
 */
async function rechazoDeLaRevision(app: AppDelCliente, g: { codigo: number | null; subcodigo?: number | null }): Promise<FallaDeLaRevision> {
  const motivo = motivoDeAlta("revisar", g.codigo, g.subcodigo);
  if (motivo === "token_vencido") return { ok: false, motivo };
  if (motivo === "esperar") return { ok: false, motivo, codigo: g.codigo };
  const propia = await leerApp(app, "");
  if (!propia.ok) return propia.falla === "rechazo" ? { ok: false, motivo: "app_invalida" } : { ok: false, motivo: propia.falla, codigo: propia.codigo };
  return g.codigo === PARAMETRO_INVALIDO ? { ok: false, motivo: "token_de_otra_app" } : { ok: false, motivo: "meta", codigo: g.codigo };
}

/**
 * Lo que el token del cliente es, según `GET /debug_token?input_token=…` con el app token en `Authorization` (R25).
 * Las reglas van en este orden y cortan en la primera:
 *   1. el app token falla con un 4xx que no es de espera: `rechazoDeLaRevision` (`app_invalida` sólo si la app tampoco entra);
 *   2. `is_valid` falso: `token_vencido`;
 *   3. `app_id` distinto: `token_de_otra_app`;
 *   4. `expires_at` distinto de 0: `token_temporal` (deducción: la página no dice qué devuelve un token sin vencimiento, I4);
 *   5. falta uno de los dos permisos de WhatsApp: `falta_permiso`;
 *   6. trae otro alcance (S3): `permisos_de_mas`;
 *   7. `wabaIds` es la intersección de los `target_ids` de los dos permisos. Un permiso sin `target_ids` vale para todos
 *      los activos y no limita; si ninguno los informa, `null`.
 */
export async function revisarTokenDeApp(token: string, app: AppDelCliente): Promise<RevisionDeToken> {
  if (!appValida(app) || !FORMATO_TOKEN.test(token)) return { ok: false, motivo: "rechazo", codigo: null };
  const r = await llamar("revisar_token", `debug_token?input_token=${encodeURIComponent(token)}`, { autorizacion: delApp(app) });
  if (!r.ok) return r.falla === "rechazo" ? rechazoDeLaRevision(app, r) : { ok: false, motivo: r.falla, codigo: r.codigo };

  const lectura = leerDebugToken(r.valor, app.appId);
  if (!lectura) {
    respuestaRara("revisar_token");
    return { ok: false, motivo: "meta", codigo: null };
  }
  if (!lectura.valido) return { ok: false, motivo: "token_vencido" };
  if (!lectura.deLaApp) return { ok: false, motivo: "token_de_otra_app" };
  if (lectura.expira !== 0) return { ok: false, motivo: "token_temporal" };

  const faltante = PERMISOS_DE_WHATSAPP.find((p) => !lectura.alcances.has(p));
  if (faltante) return { ok: false, motivo: "falta_permiso", permiso: faltante };
  const demas = [...lectura.alcances.keys()].filter(
    (p) => !(PERMISOS_DE_WHATSAPP as readonly string[]).includes(p) && !PERMISOS_TOLERADOS.includes(p)
  );
  if (demas.length > 0) return { ok: false, motivo: "permisos_de_mas", permisos: demas.slice(0, PERMISOS_MAXIMOS) };

  const listas = PERMISOS_DE_WHATSAPP.map((p) => lectura.alcances.get(p)).filter((l): l is string[] => Array.isArray(l));
  const wabaIds = listas.length === 0 ? null : [...new Set(listas.reduce((a, b) => a.filter((id) => b.includes(id))))];
  return { ok: true, usuarioId: lectura.usuarioId, wabaIds };
}

export interface Salud {
  puedeEnviar: "AVAILABLE" | "LIMITED" | "BLOCKED";
  /** Los `error_code` que Meta da por entidad, como texto: nunca su descripción. */
  motivos: string[];
}

const PUEDE_ENVIAR = ["AVAILABLE", "LIMITED", "BLOCKED"] as const;
const MOTIVOS_MAXIMOS = 20;

/**
 * `GET /{node-id}?fields=health_status` sobre la WABA o el número: si Meta deja enviar mensajes y, si no,
 * por qué. https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status
 */
export async function leerSalud(cred: CredencialDeAlta, nodo: string): Promise<RespuestaDeAlta<Salud>> {
  if (!credencialValida(cred) || !nodoValido(nodo)) return SIN_PEDIDO;
  const r = await llamar("salud", `${nodo}?fields=health_status`, delCliente(cred));
  if (!r.ok) return r;
  const estado = objeto(r.valor.health_status);
  const puedeEnviar = PUEDE_ENVIAR.find((v) => v === estado?.can_send_message);
  if (!estado || !puedeEnviar) return respuestaRara("salud");

  const motivos = new Set<string>();
  for (const entidad of Array.isArray(estado.entities) ? estado.entities : []) {
    const errores = objeto(entidad)?.errors;
    for (const error of Array.isArray(errores) ? errores : []) {
      const codigo = objeto(error)?.error_code;
      if (typeof codigo === "number" && Number.isInteger(codigo)) motivos.add(String(codigo));
    }
  }
  return { ok: true, valor: { puedeEnviar, motivos: [...motivos].slice(0, MOTIVOS_MAXIMOS) } };
}

/** `GET /{phone-number-id}?fields=verified_name,name_status,new_name_status`: el nombre visible y en qué va su revisión (R31). */
export async function leerEstadoDelNombre(
  cred: CredencialDeAlta,
  phoneNumberId: string
): Promise<RespuestaDeAlta<{ nombre: string | null; estado: string | null; estadoNuevo: string | null }>> {
  if (!credencialValida(cred) || !nodoValido(phoneNumberId)) return SIN_PEDIDO;
  const r = await llamar("estado_nombre", `${phoneNumberId}?fields=verified_name,name_status,new_name_status`, delCliente(cred));
  if (!r.ok) return r;
  return {
    ok: true,
    valor: { nombre: texto(r.valor.verified_name), estado: texto(r.valor.name_status), estadoNuevo: texto(r.valor.new_name_status) },
  };
}

const NOMBRE_MAXIMO = 512;

/**
 * Pide el nombre visible nuevo: `POST /{phone-number-id}` con `new_display_name`. Meta deja hasta 10 cambios cada
 * 30 días; al aprobarlo hay 14 días para volver a registrar el número, y registrar antes no tiene efecto (M5).
 */
export async function pedirNombreNuevo(cred: CredencialDeAlta, phoneNumberId: string, nombre: string): Promise<RespuestaDeAlta<true>> {
  const limpio = recortar(nombre);
  if (!credencialValida(cred) || !nodoValido(phoneNumberId)) return SIN_PEDIDO;
  if (!limpio || limpio.length > NOMBRE_MAXIMO || /\p{Cc}/u.test(limpio)) return SIN_PEDIDO;
  return confirmada("pedir_nombre", phoneNumberId, { ...delCliente(cred), formulario: { new_display_name: limpio } });
}

const DESCRIPCION_MAXIMA = 512;
const CAMPOS_DEL_PERFIL = "description,email,vertical";

interface CampoDelPerfil {
  /** El nombre con que lo pasa quien llama. */
  dato: "email" | "vertical" | "descripcion";
  /** El nombre que Graph le da en `whatsapp_business_profile`. */
  campo: "email" | "vertical" | "description";
  valor: string;
}

/** Los campos que se pidieron, ya validados; `null` si alguno no cumple. */
function camposDelPerfil(datos: { email?: string; vertical?: string; descripcion?: string }): CampoDelPerfil[] | null {
  const campos: CampoDelPerfil[] = [];
  if (datos.email !== undefined) {
    if (!CORREO.test(datos.email)) return null;
    campos.push({ dato: "email", campo: "email", valor: datos.email });
  }
  if (datos.vertical !== undefined) {
    if (!categoriaDePerfil(datos.vertical)) return null;
    campos.push({ dato: "vertical", campo: "vertical", valor: datos.vertical });
  }
  if (datos.descripcion !== undefined) {
    const descripcion = recortar(datos.descripcion);
    if (!descripcion || descripcion.length > DESCRIPCION_MAXIMA || /\p{Cc}/u.test(descripcion)) return null;
    campos.push({ dato: "descripcion", campo: "description", valor: descripcion });
  }
  return campos;
}

const estaVacio = (v: unknown) => v == null || (typeof v === "string" && !v.trim());

/**
 * Completa el perfil del número con lo que Meta tiene vacío, sin pisar nada que el cliente ya haya puesto: lee
 * `whatsapp_business_profile` y escribe, con `messaging_product: "whatsapp"`, sólo los campos pedidos que están
 * vacíos. Devuelve los que escribió, con el nombre con que se pasaron. La foto no se hace por acá (I31).
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
 */
export async function completarPerfil(
  cred: CredencialDeAlta,
  phoneNumberId: string,
  datos: { email?: string; vertical?: string; descripcion?: string }
): Promise<RespuestaDeAlta<string[]>> {
  if (!credencialValida(cred) || !nodoValido(phoneNumberId)) return SIN_PEDIDO;
  const pedidos = camposDelPerfil(datos);
  if (!pedidos) return SIN_PEDIDO;
  if (pedidos.length === 0) return { ok: true, valor: [] };

  const ruta = `${phoneNumberId}/whatsapp_business_profile`;
  const actual = await llamar("perfil_leer", `${ruta}?fields=${CAMPOS_DEL_PERFIL}`, delCliente(cred));
  if (!actual.ok) return actual;
  const fila = Array.isArray(actual.valor.data) ? objeto(actual.valor.data[0]) : null;
  if (!fila) return respuestaRara("perfil_leer");

  const aEscribir = pedidos.filter((p) => estaVacio(fila[p.campo]));
  if (aEscribir.length === 0) return { ok: true, valor: [] };
  const json: Record<string, unknown> = { messaging_product: "whatsapp" };
  for (const p of aEscribir) json[p.campo] = p.valor;
  const r = await confirmada("perfil_escribir", ruta, { ...delCliente(cred), json });
  return r.ok ? { ok: true, valor: aEscribir.map((p) => p.dato) } : r;
}
