/**
 * Aseguradoras — setecientas personas, cada una con su cuenta.
 *
 * El dueño quiere saber qué pasa con veinte aseguradoras de treinta a cincuenta
 * personas cada una. Ninguno de los otros perfiles contesta eso, y por una razón
 * de fondo: todos comparten una o pocas sesiones, o sea una o pocas aseguradoras.
 * Acá cada VU es una persona de verdad —su cuenta, su cookie, su balde de cupo,
 * su espacio— y las aseguradoras son espacios distintos, que es lo que ejercita
 * la separación por inquilino (RLS) bajo carga.
 *
 * ── Por qué la subida dura media hora ──────────────────────────────────────
 *
 * El login tiene tope de 30 por minuto por IP (`AUTH_POR_IP`) y desde una
 * máquina de k6 salen todos de la misma. Entrar los setecientos en `setup()`
 * tardaría lo mismo y además lo cortaría el plazo del `setup`. Así que cada VU
 * entra SOLO, en su primera vuelta, y la rampa de subida se calcula para que
 * eso pase a `LOGINS_POR_MIN` (25 por omisión, con aire para los reintentos):
 * 700 / 25 son 28 minutos. Bajar `LOGINS_POR_MIN` alarga la subida; subirlo por
 * encima de 30 se rechaza, porque mediría el limitador y no la aplicación.
 *
 * ── Qué hace cada persona ──────────────────────────────────────────────────
 *
 * Una acción cada 15 a 30 segundos, que es lo que hace alguien que mira la
 * bandeja, lee un caso y vuelve. No se martilla: ver `stress` para eso.
 *
 *   30% abre la bandeja · 30% la filtra (con selección múltiple: el parámetro
 *   repetido, `type=choque&type=robo`) · 30% abre un caso (detalle y mensajes)
 *   · 10% busca por texto.
 *
 * El caso que abre sale de SU bandeja, de su espacio: un id inventado mediría
 * el 404, que es la ruta rápida.
 *
 * ── Qué hace falta antes ───────────────────────────────────────────────────
 *
 *   CARGA_PASSWORD=… SEED_DATABASE_URL=… pnpm sembrar --carga
 *   CARGA_PASSWORD=… BASE_URL=http://localhost:3000 pnpm carga:aseguradoras
 *
 * Variables: ASEGURADORAS (20), USUARIOS_POR_ASEGURADORA (35), DURACION del
 * tramo plano (10m), LOGINS_POR_MIN (25), PAUSA_MIN_S / PAUSA_MAX_S (15 / 30).
 * Con `ASEGURADORAS=2 USUARIOS_POR_ASEGURADORA=5 DURACION=1m` es una prueba de
 * humo del escenario en un minuto.
 *
 * Los umbrales miran sólo la meseta (`fase:plano`): durante la subida de media
 * hora hay pocas personas y mezclarlas con las setecientas bajaría el p95.
 *
 * Sólo corre contra localhost, 127.0.0.1 o un host con -qa / -dev, y no hay
 * llave para saltearlo. Ver `config/destino.js`.
 */

import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter } from "k6/metrics";

import {
  BASE_URL,
  PERCENTILES,
  RUTAS_DE_CASO,
  TOPE_LOGIN_POR_MIN,
  listado,
  selectorDeLectura,
  umbrales,
} from "../config/base.js";
import {
  APELLIDOS,
  ASEGURADORAS_POR_OMISION,
  USUARIOS_POR_OMISION,
  correoDe,
  cuentaDeVu,
} from "../config/cuentas.js";
import { exigirDestinoDePrueba } from "../config/destino.js";
import { comoAnalista, entrar, esRechazoDeCupo, pedirSesion } from "../helpers/auth.js";
import { faseDeLaCarga } from "../helpers/fase.js";
import { guardar } from "../helpers/reporte.js";

exigirDestinoDePrueba("aseguradoras", BASE_URL, [__ENV.PRD_URL || ""]);

function entero(nombre, porOmision) {
  const crudo = __ENV[nombre];
  if (crudo === undefined || crudo === "") return porOmision;
  const n = Number(crudo);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${nombre}=${crudo}: tiene que ser un entero positivo.`);
  }
  return n;
}

const ASEGURADORAS = entero("ASEGURADORAS", ASEGURADORAS_POR_OMISION);
const USUARIOS = entero("USUARIOS_POR_ASEGURADORA", USUARIOS_POR_OMISION);
const TOTAL = ASEGURADORAS * USUARIOS;
const DURACION = __ENV.DURACION || "10m";
const LOGINS_POR_MIN = entero("LOGINS_POR_MIN", 25);
const PAUSA_MIN_S = entero("PAUSA_MIN_S", 15);
const PAUSA_MAX_S = entero("PAUSA_MAX_S", 30);
const CLAVE = __ENV.CARGA_PASSWORD || "";

if (LOGINS_POR_MIN > TOPE_LOGIN_POR_MIN) {
  throw new Error(
    `LOGINS_POR_MIN=${LOGINS_POR_MIN} pasa el tope del login (${TOPE_LOGIN_POR_MIN} por minuto por IP): ` +
      `lo que se mediría es el limitador.`
  );
}
if (PAUSA_MIN_S > PAUSA_MAX_S) {
  throw new Error(`PAUSA_MIN_S=${PAUSA_MIN_S} es mayor que PAUSA_MAX_S=${PAUSA_MAX_S}.`);
}
if (!CLAVE) {
  throw new Error(
    "Falta CARGA_PASSWORD: la contraseña con la que `pnpm sembrar --carga` creó las cuentas.\n" +
      "  No hay valor por omisión ni se guarda en ningún archivo."
  );
}

/** Los minutos de subida: tantos como hagan falta para entrar a `LOGINS_POR_MIN`. */
const RAMPA_MIN = Math.ceil(TOTAL / LOGINS_POR_MIN);

/** Logins que no devolvieron sesión (429 del tope por IP, cuenta inexistente, 5xx). */
const loginsFallidos = new Counter("logins_fallidos");

export const options = {
  stages: [
    { duration: `${RAMPA_MIN}m`, target: TOTAL },
    { duration: DURACION, target: TOTAL },
    { duration: "2m", target: 0 },
  ],
  // Como smoke: una API que pasara a redirigir a /login no se mide como sana.
  maxRedirects: 0,
  summaryTrendStats: PERCENTILES,
  // La subida dura media hora con poca gente: los umbrales miran sólo la meseta.
  thresholds: umbrales(
    {
      // Un puñado de logins reintentados es normal con la subida pegada al tope
      // por IP; más del 2% es que algo anda mal con las cuentas o con la subida.
      logins_fallidos: [`count<=${Math.ceil(TOTAL * 0.02)}`],
    },
    "plano"
  ),
};

/**
 * Antes de levantar setecientos VUs, una persona: si no entra o no ve casos,
 * el resto es un 401 multiplicado por setecientos.
 */
export function setup() {
  const cookie = entrar({ correo: correoDe(1, 1), clave: CLAVE });
  const res = http.get(`${BASE_URL}${listado(1)}`, comoAnalista({ cookie }, "setup"));
  if (res.status !== 200) {
    fail(`La bandeja contestó ${res.status} en el setup. Sin ella no hay nada que medir.`);
  }
  const ids = res.json("data.#.id");
  if (!ids || ids.length === 0) {
    fail(
      "La primera cuenta no ve ningún caso. ¿Se sembró con `pnpm sembrar --carga` " +
        "en la misma base que sirve BASE_URL?"
    );
  }

  console.log(
    `${ASEGURADORAS} aseguradoras x ${USUARIOS} = ${TOTAL} VUs · subida de ${RAMPA_MIN} min ` +
      `(${LOGINS_POR_MIN} logins/min) · ${DURACION} planos · pausa ${PAUSA_MIN_S}-${PAUSA_MAX_S} s`
  );
}

// Estado de CADA VU: k6 le da su propio runtime, así que esto no se comparte.
let cookie = "";
let ids = [];

/** Los filtros que usa la gente. Los arreglos se mandan repetidos: `type=choque&type=robo`. */
const FILTROS = [
  { type: ["choque", "robo"] },
  { type: ["granizo", "incendio"], status: ["procesando", "escalado"] },
  { status: ["listo", "cerrado"] },
  { channel: ["whatsapp_sim", "email_sim"], type: ["choque", "rc", "cristales"] },
  { status: ["info_faltante"] },
];

function consulta(parametros) {
  return Object.entries(parametros)
    .flatMap(([clave, valor]) =>
      (Array.isArray(valor) ? valor : [valor]).map(
        (v) => `${encodeURIComponent(clave)}=${encodeURIComponent(v)}`
      )
    )
    .join("&");
}

function elegir(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

function leer(ruta, accion) {
  const res = http.get(
    `${BASE_URL}${ruta}`,
    comoAnalista({ cookie }, "lectura", { accion, fase: faseDeLaCarga(TOTAL) })
  );
  esRechazoDeCupo(res);
  check(res, { [`${accion} 200`]: (r) => r.status === 200 });
  // Sesión perdida: la próxima vuelta vuelve a entrar en vez de pedir 401s.
  if (res.status === 401) cookie = "";
  return res;
}

/** Se queda con los ids de lo último que vio en pantalla: de ahí abre el caso. */
function recordar(res) {
  if (res.status !== 200) return;
  try {
    const vistos = res.json("data.#.id");
    if (vistos && vistos.length > 0) ids = vistos;
  } catch (e) {
    // Cuerpo que no es JSON: el check de la acción ya lo marcó.
  }
}

const ACCIONES = {
  bandeja() {
    recordar(leer(listado(50), "bandeja"));
  },
  filtrar() {
    recordar(leer(listado(25, consulta(elegir(FILTROS))), "filtrar"));
  },
  abrir() {
    if (ids.length === 0) return ACCIONES.bandeja();
    const id = elegir(ids);
    leer(RUTAS_DE_CASO.detalle(id), "detalle");
    leer(RUTAS_DE_CASO.mensajes(id), "mensajes");
  },
  buscar() {
    recordar(leer(listado(25, consulta({ q: elegir(APELLIDOS) })), "buscar"));
  },
};

function sortear() {
  const dado = Math.random();
  return dado < 0.3 ? "bandeja" : dado < 0.6 ? "filtrar" : dado < 0.9 ? "abrir" : "buscar";
}

/** Entra con la cuenta de este VU. `false` si no hubo sesión: se reintenta en la próxima vuelta. */
function iniciar() {
  const yo = cuentaDeVu(((__VU - 1) % TOTAL) + 1, USUARIOS);
  const { res, cookie: nueva } = pedirSesion({ correo: yo.correo, clave: CLAVE });
  if (res.status === 200 && nueva) {
    cookie = nueva;
    return true;
  }
  loginsFallidos.add(1);
  // Sólo los primeros VUs hablan: si fallan todos, setecientas líneas no ayudan.
  if (__VU <= 3) {
    console.warn(`VU ${__VU}: el login de ${yo.correo} contestó ${res.status}. ${(res.body || "").slice(0, 120)}`);
  }
  return false;
}

export default function () {
  if (!cookie) {
    if (!iniciar()) {
      // Con aire para que un 429 del tope por IP se despeje, y sin sincronizar a nadie.
      sleep(10 + Math.random() * 20);
      return;
    }
    // Lo primero que hace quien llega es abrir la bandeja.
    ACCIONES.bandeja();
  } else {
    ACCIONES[sortear()]();
  }
  sleep(PAUSA_MIN_S + Math.random() * (PAUSA_MAX_S - PAUSA_MIN_S));
}

export function handleSummary(datos) {
  const fallidos = datos.metrics.logins_fallidos;
  // Los VUs de la corrida, no los del archivo: k6 deja pisarlos con `--stage`.
  const vus = datos.metrics.vus_max ? datos.metrics.vus_max.values.max : "?";
  return guardar(datos, "aseguradoras", {
    "qué mide": "si la aplicación aguanta muchas aseguradoras a la vez, cada persona con su cuenta y su espacio",
    "modelo": `${ASEGURADORAS} aseguradoras de ${USUARIOS} personas (${vus} VUs en la corrida), una acción cada ${PAUSA_MIN_S}-${PAUSA_MAX_S} s`,
    "subida": `${RAMPA_MIN} min a ${LOGINS_POR_MIN} logins por minuto (el tope del login es ${TOPE_LOGIN_POR_MIN}/min por IP)`,
    "mezcla": "30% bandeja · 30% filtros con selección múltiple · 30% abrir un caso · 10% búsqueda",
    "logins fallidos": fallidos ? fallidos.values.count : 0,
    "medido sobre": `la meseta de ${DURACION}, sin la subida de ${RAMPA_MIN} min ni la bajada`,
  }, selectorDeLectura("plano"));
}
