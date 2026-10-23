/**
 * Las reglas de `pnpm alta:probar`, aparte del guión para poder probarlas sin
 * red ni base: sin imports de `@/`, sin entorno y sin I/O.
 *
 * Lo que el guión imprime sale de la tabla cerrada de acá: un código, su nivel y
 * un texto fijo. Los logs de Actions son públicos, así que nunca llevan un valor
 * de bandera, un conteo, un correo, un id ni una cadena: sólo el nombre del
 * campo y el veredicto.
 */

export type Nivel = "bien" | "inconcluso" | "rojo";

const TABLA = {
  // Lo que anduvo.
  salud_ok: { nivel: "bien", texto: "el ambiente contesta y trae su configuración" },
  registro_ok: { nivel: "bien", texto: "el formulario de registro coincide con el ambiente" },
  enlace_ajeno_rechazado: { nivel: "bien", texto: "el despliegue rechaza un enlace sellado con otro secreto" },
  margen_ok: { nivel: "bien", texto: "hay margen en el tope de altas del día" },
  enlace_ok: { nivel: "bien", texto: "el enlace del correo dejó la cuenta con el correo verificado y la sesión, sin espacio" },
  enlace_viejo_ok: { nivel: "bien", texto: "un enlace de antes de separar los dos pasos abre sólo la cuenta" },
  alta_ok: { nivel: "bien", texto: "pedir el espacio con la cuenta ya hecha dejó el espacio completo" },
  segunda_vez_ok: { nivel: "bien", texto: "abrir de nuevo el mismo enlace no creó nada" },
  contadores_ok: { nivel: "bien", texto: "los cupos por red se contaron como corresponde" },
  cupo_devuelto: { nivel: "bien", texto: "el cupo de un alta que no creó nada se devolvió" },
  tope_por_ip_ok: { nivel: "bien", texto: "el tope por red cortó el intento que se pasaba" },
  barrido_ok: { nivel: "bien", texto: "el barrido no dejó nada de la prueba" },

  // Lo que no se pudo probar: no es que el alta se rompió.
  no_contesta: { nivel: "inconcluso", texto: "el despliegue no contestó, no se pudo probar" },
  salud_ilegible: { nivel: "inconcluso", texto: "el despliegue contestó algo ilegible, no se pudo probar" },
  otro_commit: { nivel: "inconcluso", texto: "el despliegue ya es de otro commit, lo probado no es lo desplegado" },
  base_por_cliente_prendida: { nivel: "inconcluso", texto: "el ambiente usa base por cliente, que esta prueba no cubre" },
  registro_no_contesta: { nivel: "inconcluso", texto: "la pantalla de registro no contestó, no se pudo revisar" },
  enlace_no_contesta: { nivel: "inconcluso", texto: "la pantalla del enlace no contestó, no se pudo revisar" },
  candado_ocupado: { nivel: "inconcluso", texto: "otra corrida de la prueba tiene el candado, no se pudo probar" },
  tope_lleno: { nivel: "inconcluso", texto: "el tope de altas del día está lleno, no se pudo probar" },
  cerca_del_aviso: { nivel: "inconcluso", texto: "el día va cerca del aviso al operador, no se probó para no dispararlo" },
  numero_ocupado: { nivel: "inconcluso", texto: "un número de la prueba ya estaba en uso, no se pudo probar" },
  contador_movido: { nivel: "inconcluso", texto: "la ventana de un cupo cambió en medio de la prueba, no se comparó" },
  contador_sin_respuesta: { nivel: "inconcluso", texto: "el contador de cupos no contestó, no se pudo probar" },
  pasajero: { nivel: "inconcluso", texto: "falló la red o la conexión con la base, no se pudo probar" },
  barrido_sin_candado: { nivel: "inconcluso", texto: "el barrido no consiguió el candado, puede haber quedado algo" },
  barrido_pasajero: { nivel: "inconcluso", texto: "el barrido falló por la red, lo que quede lo limpia la próxima corrida" },

  // Lo que se rompió.
  sin_permiso: { nivel: "rojo", texto: "el despliegue rechazó el secreto de la prueba" },
  sin_banderas: { nivel: "rojo", texto: "el despliegue no informó su configuración" },
  alta_apagada: { nivel: "rojo", texto: "el alta automática está apagada en el ambiente de prueba" },
  registro_sin_formulario: { nivel: "rojo", texto: "la pantalla de registro no trae el formulario" },
  registro_pide_empresa: { nivel: "rojo", texto: "la pantalla de registro pide la empresa o el número, que van en el segundo paso" },
  registro_correo_incoherente: { nivel: "rojo", texto: "el campo del correo en el registro no coincide con el ambiente" },
  registro_turnstile_incoherente: { nivel: "rojo", texto: "el desafío del registro no coincide con el ambiente" },
  token_ajeno_aceptado: { nivel: "rojo", texto: "el despliegue aceptó un enlace sellado con otro secreto" },
  enlace_ilegible: { nivel: "rojo", texto: "la pantalla del enlace no mostró ni el formulario ni el aviso de vencido" },
  tope_0: { nivel: "rojo", texto: "el tope de altas del día cierra el alta" },
  destino_inesperado: { nivel: "rojo", texto: "el enlace o el pedido del espacio terminó en un destino que no corresponde" },
  enlace_creo_espacio: { nivel: "rojo", texto: "el enlace del correo creó un espacio, un perfil o un número, y sólo tenía que crear la cuenta" },
  correo_sin_verificar: { nivel: "rojo", texto: "la cuenta quedó sin el correo verificado" },
  sin_perfil_de_dueno: { nivel: "rojo", texto: "el espacio quedó sin perfil de dueño" },
  inquilino_mal_creado: { nivel: "rojo", texto: "el espacio se creó con datos que no corresponden" },
  sin_numero: { nivel: "rojo", texto: "el espacio quedó sin su número de WhatsApp" },
  sin_auditoria: { nivel: "rojo", texto: "el alta no dejó su registro de auditoría" },
  sin_sesion: { nivel: "rojo", texto: "la persona quedó sin sesión después del alta" },
  cupos_mal_contados: { nivel: "rojo", texto: "los cupos por red no se contaron como corresponde" },
  segunda_vez_creo_algo: { nivel: "rojo", texto: "abrir de nuevo el mismo enlace creó algo" },
  cupo_no_devuelto: { nivel: "rojo", texto: "el cupo de un alta que no creó nada no se devolvió" },
  tope_por_ip_no_corta: { nivel: "rojo", texto: "el tope por red no cortó el intento que se pasaba" },
  migracion_pendiente: { nivel: "rojo", texto: "falta aplicar una migración del alta en la base de prueba" },
  tope_de_bases: { nivel: "rojo", texto: "el tope de bases cierra el alta" },
  tope_de_mb: { nivel: "rojo", texto: "el tope de tamaño de las bases cierra el alta" },
  alta_cerrada_sin_conteo: { nivel: "rojo", texto: "el alta se cerró sin conteo y sin una causa que la prueba reconozca" },
  resultado_inesperado: { nivel: "rojo", texto: "la creación del espacio dio un resultado que la prueba no conoce" },
  error_pg: { nivel: "rojo", texto: "la base devolvió un error que no es de red" },
  error: { nivel: "rojo", texto: "la prueba falló con un error inesperado" },
  residuo: { nivel: "rojo", texto: "después del barrido quedaron datos de la prueba" },
  barrido_fallo: { nivel: "rojo", texto: "el barrido falló y puede haber quedado algo de la prueba" },
} as const satisfies Record<string, { nivel: Nivel; texto: string }>;

export type CodigoDeHallazgo = keyof typeof TABLA;
export interface Hallazgo {
  nivel: Nivel;
  codigo: CodigoDeHallazgo;
  texto: string;
}

export const HALLAZGOS: Record<CodigoDeHallazgo, { nivel: Nivel; texto: string }> = TABLA;

/** El hallazgo de un código: el nivel y el texto salen sólo de la tabla. */
export function hallazgo(c: CodigoDeHallazgo): Hallazgo {
  return { nivel: HALLAZGOS[c].nivel, codigo: c, texto: HALLAZGOS[c].texto };
}

/** La línea del log, con la anotación de Actions que corresponde al nivel. */
export function formatear(h: Hallazgo): string {
  const anotacion = h.nivel === "rojo" ? "::error::" : h.nivel === "inconcluso" ? "::warning::" : "";
  return `${anotacion}alta: ${h.codigo} — ${h.texto}`;
}

/* ───── La identidad de la corrida ───── */

export const PREFIJO_CORREO = "alta-probar-";
export const PREFIJO_EMPRESA = "zz-alta-probar-";
/** Las claves de cupo de la red TEST-NET-3 (RFC 5737): lo único que el barrido borra de rate_limit_counters. */
export const CUPOS_DE_LA_RED_DE_PRUEBA = /(^|:)203\.0\.113\.[0-9]{1,3}($|:)/;

/** Un desplazamiento fijo por escenario: dos corridas distintas no comparten red salvo que la base coincida. */
export const LETRAS = { g: 0, a: 1, b: 2, r: 3, v: 4 } as const;
export type Letra = keyof typeof LETRAS;

export function esCorrida(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{6}$/.test(s);
}

function comoCorrida(corrida: string): string {
  if (!esCorrida(corrida)) throw new Error("corrida inválida");
  return corrida;
}

const semilla = (corrida: string) => parseInt(comoCorrida(corrida), 16);

/** Una base por corrida más el desplazamiento de la letra: nunca dos escenarios en la misma IP. */
export function ipDe(corrida: string, l: Letra): string {
  return `203.0.113.${(((semilla(corrida) % 254) + LETRAS[l]) % 254) + 1}`;
}

/** Del bloque 5490000 (src/core/phone/reserved.ts): nunca es de una persona. */
export function numeroDe(corrida: string, l: Letra): string {
  return `+5490000${String(semilla(corrida) % 1_000_000).padStart(6, "0")}${LETRAS[l] + 1}`;
}

export function correoDe(corrida: string, l: Letra): string {
  return `${PREFIJO_CORREO}${comoCorrida(corrida)}-${l}@example.com`;
}

export function empresaDe(corrida: string, l: Letra): string {
  return `${PREFIJO_EMPRESA}${comoCorrida(corrida)}-${l}`;
}

/* ───── Los topes ───── */

export const NOMBRES_DE_TOPES = [
  "ALTA_TOPE_GLOBAL_DIA",
  "ALTA_TOPE_BASES",
  "ALTA_TOPE_MB",
  "ALTA_TOPE_IP_DIA",
  "ALTA_PRUEBA_DIAS",
] as const;

/**
 * Los topes que rigen en el deploy, como texto para el entorno del proceso. Un
 * número finito da su texto; cualquier otro valor (null es «rige la omisión»,
 * como dice `banderas.ts`) da vacío, y el código usa su omisión.
 */
export function topesDesdeBanderas(b: Record<string, unknown>): Record<(typeof NOMBRES_DE_TOPES)[number], string> {
  return Object.fromEntries(
    NOMBRES_DE_TOPES.map((n) => [n, typeof b[n] === "number" && Number.isFinite(b[n]) ? String(b[n]) : ""])
  ) as Record<(typeof NOMBRES_DE_TOPES)[number], string>;
}

/* ───── Lo que se lee del deploy ───── */

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `/api/health`: 200 y 503 traen las banderas (un 503 es «alguna dependencia caída», no «sin configuración»). */
export function leerSalud(
  codigo: number,
  cuerpo: unknown,
  sha?: string
): { banderas: Record<string, unknown> | null; hallazgos: Hallazgo[] } {
  const sin = (c: CodigoDeHallazgo) => ({ banderas: null, hallazgos: [hallazgo(c)] });
  if (codigo === 0) return sin("no_contesta");
  if (codigo === 401) return sin("sin_permiso");
  if (codigo !== 200 && codigo !== 503) return sin("salud_ilegible");
  const raiz = esObjeto(cuerpo) ? cuerpo : null;
  const banderas = raiz && esObjeto(raiz.banderas) ? raiz.banderas : null;
  if (!raiz || !banderas) return sin("sin_banderas");
  if (banderas.ALTA_AUTOMATICA !== true) return sin("alta_apagada");

  const hallazgos: Hallazgo[] = [];
  if (banderas.BASE_POR_CLIENTE === true) hallazgos.push(hallazgo("base_por_cliente_prendida"));
  // El commit sale recortado a 7 en /api/health.
  if (sha && raiz.commit !== sha.slice(0, 7)) hallazgos.push(hallazgo("otro_commit"));
  if (hallazgos.length === 0) hallazgos.push(hallazgo("salud_ok"));
  return { banderas, hallazgos };
}

/**
 * /registro: el HTML del servidor trae los términos y NO pide la empresa ni el
 * número (van en /alta), y el correo y el desafío aparecen si y sólo si el
 * ambiente los tiene cargados. El desafío vive dentro del camino por correo
 * (SignUpForm), así que necesita las dos cosas.
 */
export function revisarRegistro(codigo: number, html: string, b: Record<string, unknown>): Hallazgo[] {
  if (codigo !== 200) return [hallazgo("registro_no_contesta")];
  const hallazgos: Hallazgo[] = [];
  if (!html.includes('name="terminos"')) hallazgos.push(hallazgo("registro_sin_formulario"));
  if (html.includes('name="empresa"') || html.includes('name="whatsapp"')) {
    hallazgos.push(hallazgo("registro_pide_empresa"));
  }
  const conCorreo =
    b.ALTA_REMITENTE_CORREO === true &&
    b.ALTA_REMITENTE_REFRESH_TOKEN === true &&
    b.GMAIL_CLIENT_ID === true &&
    b.GMAIL_CLIENT_SECRET === true;
  const conTurnstile = b.TURNSTILE_SITE_KEY === true && b.TURNSTILE_SECRET_KEY === true;
  if (html.includes('id="registro-correo"') !== conCorreo) hallazgos.push(hallazgo("registro_correo_incoherente"));
  if (html.includes('class="cf-turnstile"') !== (conCorreo && conTurnstile)) {
    hallazgos.push(hallazgo("registro_turnstile_incoherente"));
  }
  if (hallazgos.length === 0) hallazgos.push(hallazgo("registro_ok"));
  return hallazgos;
}

/** /alta/correo con un enlace sellado con otro secreto: tiene que decir «vencido» y no pedir la clave. */
export function revisarEnlaceAjeno(codigo: number, html: string): Hallazgo {
  if (codigo !== 200) return hallazgo("enlace_no_contesta");
  if (html.includes('name="password"')) return hallazgo("token_ajeno_aceptado");
  if (html.includes('href="/registro"')) return hallazgo("enlace_ajeno_rechazado");
  return hallazgo("enlace_ilegible");
}

/* ───── Errores y cierre del alta ───── */

/** Los SQLSTATE que dicen «la conexión o el servidor no están», no «el alta está mal». */
const PG_PASAJEROS = new Set(["53300", "57P01", "57P02", "57P03", "57014", "40001", "40P01", "55P03"]);
const DE_TRANSPORTE =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed|socket hang up|WebSocket|Connection terminated|Error connecting to database/i;

export function clasificarError(codigo: string | undefined, mensaje: string): "pasajero" | "pg" | "otro" {
  if (codigo !== undefined && (codigo.startsWith("08") || PG_PASAJEROS.has(codigo))) return "pasajero";
  if (DE_TRANSPORTE.test(mensaje)) return "pasajero";
  return codigo !== undefined && codigo.length === 5 ? "pg" : "otro";
}

/**
 * Las rutas con que los módulos de verdad devuelven un error de la base o de la
 * red que se tragaron: `/alta?e=falla` (el espacio no se creó), `…&e=falla` (la
 * cuenta no se creó) y `/login` (la cuenta se creó y la sesión no se abrió).
 */
export function esFallaTragada(destino: string): boolean {
  return destino === "/login" || /[?&]e=falla$/.test(destino);
}

/**
 * Qué se anota cuando un paso terminó donde no debía. Con el logger apagado la
 * causa de una falla tragada no sale, así que se mira la base aparte
 * (`baseContesta`, una consulta suelta hecha al momento): si no contesta, es un
 * parpadeo de la red, «no se pudo probar» como cuando el error llegaba entero y
 * era de transporte; si contesta, el paso falló con la base arriba y eso es un
 * defecto, que pone rojo. Cualquier otra ruta es un destino que no corresponde.
 */
export function codigoDeDestinoInesperado(
  destino: string,
  baseContesta: boolean
): "pasajero" | "destino_inesperado" {
  return esFallaTragada(destino) && !baseContesta ? "pasajero" : "destino_inesperado";
}

/**
 * Por qué `crearInquilino` dio `alta_cerrada` sin conteos, en el orden en que
 * `crear-inquilino.ts` los corta: falta la migración (42883, 42P01, 42703), el tope
 * de bases, el tope de MB. Si nada de eso, fue un 23505 de dos altas pisándose y
 * sólo entonces se reintenta.
 */
export function diagnosticarCierre(d: {
  funcion: boolean;
  objetos: boolean;
  topeBases: number;
  bases: number;
  topeMb: number;
  mb: number;
}): "migracion_pendiente" | "tope_de_bases" | "tope_de_mb" | "posible_23505" {
  if (!d.funcion || !d.objetos) return "migracion_pendiente";
  if (d.topeBases > 0 && d.bases >= d.topeBases) return "tope_de_bases";
  if (d.topeMb > 0 && d.mb >= d.topeMb) return "tope_de_mb";
  return "posible_23505";
}

/* ───── Margen, contadores y veredictos ───── */

/**
 * ¿Hay lugar para crear un espacio sin tocar el tope ni disparar el aviso del
 * 80 %? Con margen para esta corrida y un alta de verdad que llegue a la vez.
 * `llegoAlAviso` es el de `aviso-operador.ts`, para que la regla no se copie.
 */
export function margenDelTope(c: number, tope: number, llegoAlAviso: (c: number, t: number) => boolean): Hallazgo {
  if (tope === 0) return hallazgo("tope_0");
  if (c + 1 > tope) return hallazgo("tope_lleno");
  if (llegoAlAviso(c + 2, tope)) return hallazgo("cerca_del_aviso");
  return hallazgo("margen_ok");
}

/**
 * Cuánto sube cada cupo de la red, contado desde antes del primer paso: el enlace
 * gasta `auth:ip` y ningún cupo de alta; pedir el espacio gasta `alta:ip`; abrir el
 * mismo enlace otra vez gasta `auth:ip` y nada más.
 */
export const CUPOS_ESPERADOS = {
  enlace: { "auth:ip": 1, "alta:ip": 0 },
  espacio: { "auth:ip": 1, "alta:ip": 1 },
  enlaceOtraVez: { "auth:ip": 2, "alta:ip": 1 },
} as const;

/** Lo que subió cada contador entre antes y después contra lo que tenía que subir. Un contador que no existía vale 0. */
export function compararContadores(
  antes: Record<string, number>,
  despues: Record<string, number>,
  esperado: Record<string, number>
): Hallazgo {
  const igual = Object.entries(esperado).every(([k, n]) => (despues[k] ?? 0) - (antes[k] ?? 0) === n);
  return hallazgo(igual ? "contadores_ok" : "cupos_mal_contados");
}

/** Un rojo es «el alta se rompió»; un inconcluso es «no se pudo probar» y no pone rojo el job. */
export function veredicto(h: Hallazgo[]): { resultado: "probado" | "inconcluso" | "rojo"; salida: 0 | 1 } {
  if (h.some((x) => x.nivel === "rojo")) return { resultado: "rojo", salida: 1 };
  if (h.some((x) => x.nivel === "inconcluso")) return { resultado: "inconcluso", salida: 0 };
  return { resultado: "probado", salida: 0 };
}

export function veredictoDelBarrido(r: {
  candado: boolean;
  error?: "pasajero" | "pg" | "otro";
  residuo: number;
}): { hallazgo: Hallazgo; salida: 0 | 1 } {
  if (!r.candado) return { hallazgo: hallazgo("barrido_sin_candado"), salida: 0 };
  if (r.error === "pasajero") return { hallazgo: hallazgo("barrido_pasajero"), salida: 0 };
  if (r.error) return { hallazgo: hallazgo("barrido_fallo"), salida: 1 };
  if (r.residuo > 0) return { hallazgo: hallazgo("residuo"), salida: 1 };
  return { hallazgo: hallazgo("barrido_ok"), salida: 0 };
}
