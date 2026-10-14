/**
 * Cómo le cuenta /conectar-whatsapp a la persona lo que pasó con su WABA propia.
 *
 * Las acciones devuelven un nombre de una lista cerrada, nunca un texto ni un
 * mensaje de Graph: lo que vuelve al navegador no puede meter nada en la pantalla,
 * y la interfaz pinta el texto de cada resultado desde su propio diccionario.
 *
 * Sin imports a propósito: la usan la página, las acciones y el panel sin
 * arrastrar nada.
 */

export const RESULTADOS_DE_WABA = [
  "listo",
  "conectado",
  "codigo_enviado",
  "falta_codigo",
  "codigo_incorrecto",
  "falta_pin",
  "pin_incorrecto",
  "numero_distinto",
  "sin_numero",
  "coexistencia",
  "de_la_plataforma",
  "numero_ocupado",
  "vencido",
  "cupo",
  "esperar",
  "meta",
  "revision",
  "cancelado",
  "desconectado",
  "apagado",
  "sdk_bloqueado",
] as const;

export type ResultadoDeWaba = (typeof RESULTADOS_DE_WABA)[number];

export function esResultadoDeWaba(valor: unknown): valor is ResultadoDeWaba {
  return typeof valor === "string" && (RESULTADOS_DE_WABA as readonly string[]).includes(valor);
}

/**
 * Por qué quedó mal una WABA. Es la lista que acepta la función de la base en el
 * paso `estado`: una causa que no esté acá no se puede escribir.
 */
export const FALLAS_DE_WABA = [
  "canje",
  "token_invalido",
  "suscripcion",
  "registro",
  "webhook",
  "token_vencido",
  "nombre_rechazado",
  "coexistencia",
  "sin_numero",
  "secreto_invalido",
  "waba_restringida",
  "waba_bloqueada",
  "pago_pendiente",
] as const;

export type FallaDeWaba = (typeof FALLAS_DE_WABA)[number];

/** Fallas que sólo escribe la vía «app propia»: el panel del popup no tiene texto propio para ellas. */
export const FALLAS_SOLO_DE_APP = ["secreto_invalido", "waba_restringida", "waba_bloqueada", "pago_pendiente"] as const;

export type FallaDelPopup = Exclude<FallaDeWaba, (typeof FALLAS_SOLO_DE_APP)[number]>;

export const FALLAS_DEL_POPUP: readonly FallaDelPopup[] = FALLAS_DE_WABA.filter(
  (f): f is FallaDelPopup => !(FALLAS_SOLO_DE_APP as readonly string[]).includes(f)
);

/** Los pasos del popup de Meta en los que alguien puede cancelar, tal como los manda el SDK. */
export const PASOS_CANCELADOS = [
  "business_account_selection",
  "waba_phone_profile_picker",
  "whatsapp_business_profile_setup",
  "phone_number_setup",
  "phone_number_verification",
  "permissions",
  "otro",
] as const;

export type PasoCancelado = (typeof PASOS_CANCELADOS)[number];

/**
 * El paso que el navegador dice haber cancelado, reducido a la lista. Viene de un
 * evento que escribe quien llama: lo que no sea un nombre conocido es «otro», y
 * nunca llega a la base ni al log tal cual.
 */
export function pasoCancelado(valor: unknown): PasoCancelado {
  const paso = typeof valor === "string" ? valor.toLowerCase() : "";
  return (PASOS_CANCELADOS as readonly string[]).includes(paso) ? (paso as PasoCancelado) : "otro";
}

/**
 * Una WABA propia que ya tuvo su número conectado con su token y volvió a quedar a
 * medias: cayó en `falla` (token vencido, nombre rechazado) o la persona está
 * conectándola de nuevo. No es un espacio «ya conectado»: tiene que poder reabrir el
 * popup o reintentar, y el número sigue vivo mientras tanto. `conToken` es el token
 * de esta WABA (no el del camino viejo); un número suspendido por el operador no vuelve por acá.
 */
export function reconectando(w: { estado: string | null; numero: string | null; conToken: boolean }): boolean {
  return (
    w.numero === "conectado" &&
    w.conToken &&
    (w.estado === "falla" ||
      w.estado === "vinculada" ||
      w.estado === "suscripta" ||
      w.estado === "falta_codigo" ||
      w.estado === "falta_pin")
  );
}

/**
 * Lo que puede contestar una acción de la vía «app propia»: todo lo de la WABA propia
 * más lo que sólo esta vía dice (formatos, la app, el webhook, el token, el nombre).
 * Mismo criterio de siempre: nombres de una lista cerrada, nunca un texto de Graph.
 */
export const RESULTADOS_DE_APP = [
  "formato",
  "formato_app",
  "formato_secreto",
  "parece_token",
  "app_invalida",
  "app_ocupada",
  "app_de_la_plataforma",
  "otra_app",
  "cuit_invalido",
  "razon_invalida",
  "numero_invalido",
  "webhook_pendiente",
  "webhook_demora",
  "token_formato",
  "token_de_otra_app",
  "token_temporal",
  "token_vencido",
  "falta_permiso",
  "permisos_de_mas",
  "waba_no_asignada",
  "waba_formato",
  "waba_invalida",
  "elegir_numero",
  "pago_pendiente",
  "nombre_rechazado",
  "nombre_invalido",
  "nombre_pendiente",
  "waba_restringida",
  "waba_bloqueada",
  "ya_conectado",
  "transicion",
] as const;

export type ResultadoDeApp = ResultadoDeWaba | (typeof RESULTADOS_DE_APP)[number];

export function esResultadoDeApp(valor: unknown): valor is ResultadoDeApp {
  return esResultadoDeWaba(valor) || (typeof valor === "string" && (RESULTADOS_DE_APP as readonly string[]).includes(valor));
}

/** La versión del anexo de tratamiento de datos que el cliente acepta al abrir el alta con su app (año y mes). La comparan el servidor y la pantalla. */
export const VERSION_DEL_ANEXO = "2026-10";

/** Cómo se conecta el número de este espacio: con la WABA propia, con su app de Meta, con el código, o de ninguna forma. */
export type MetodoDelNumero = "propia" | "app" | "codigo" | null;

/** Cómo nació la fila viva de `whatsapp_wabas`: por el popup de Meta o con la app que creó el cliente. */
export type OrigenDeWaba = "embedded_signup" | "app_propia";

/**
 * Qué panel le toca a un espacio. `origen` es el de su fila viva de WABA (ni `cancelada`
 * ni `revocada`): manda sobre las banderas, para que la persona vea el estado de lo que ya
 * tiene aunque se apaguen (las acciones contestan «apagado»). Con las dos banderas
 * prendidas gana el popup; la app propia queda como enlace avanzado. `idEnLaPlataforma` es
 * un número que quedó a medias en la WABA de la plataforma: el camino viejo lo termina, si
 * está prendido.
 */
export function metodoDelNumero(p: {
  wabaPropia: boolean;
  appPropia: boolean;
  numeroAutomatico: boolean;
  esAdmin: boolean;
  autoalta: boolean;
  idEnLaPlataforma: boolean;
  origen: OrigenDeWaba | null;
}): MetodoDelNumero {
  if (!p.esAdmin || !p.autoalta) return null;
  if (p.origen === "app_propia") return "app";
  if (p.origen === "embedded_signup") return "propia";
  if (p.idEnLaPlataforma && p.numeroAutomatico && (p.wabaPropia || p.appPropia)) return "codigo";
  if (p.wabaPropia) return "propia";
  if (p.appPropia) return "app";
  return p.numeroAutomatico ? "codigo" : null;
}
