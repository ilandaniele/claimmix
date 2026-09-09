/**
 * Las sesiones, y por qué hacen falta VARIAS.
 *
 * ── Primero: una por VU no se puede ────────────────────────────────────────
 *
 * El login tiene tope de cinco intentos cada diez segundos por IP y correo. Con
 * doscientos VUs logueándose, lo que se mide es ese tope: al sexto pedido
 * empieza a contestar 429 y la corrida reporta que el login está roto. Ya pasó
 * con Playwright —catorce tests, nueve logins— y el arreglo fue el mismo:
 * entrar una vez y compartir la cookie. Ver `tests/e2e/auth.setup.ts`.
 *
 * ── Y después: una sola tampoco ────────────────────────────────────────────
 *
 * `/api/cases` tiene cupo de 100 por minuto POR USUARIO (`CASES_API`), y las
 * tres rutas más pesadas de la mezcla comparten la misma etiqueta, o sea el
 * mismo balde. Cincuenta VUs sondeando cada cinco segundos son ~510 pedidos por
 * minuto contra un tope de 100.
 *
 * Con una sola cuenta, esos cincuenta VUs no miden la aplicación: miden el
 * limitador. Y la corrida sale roja por `http_req_failed` mientras el p95 sale
 * VERDE, porque un 429 se contesta rapidísimo. Es el p95 de que te rechacen.
 *
 * Cincuenta analistas de verdad tienen cincuenta baldes de 100. Para
 * reproducir eso hacen falta varias cuentas, y el reparto es `__VU % n`.
 *
 * `scripts/load-test.mts` ya había documentado exactamente este problema como
 * la razón para NO escribir la versión por HTTP. Se escribió igual, y sin esto.
 */

import http from "k6/http";
import { fail } from "k6";
import { Counter } from "k6/metrics";

import { BASE_URL, cabecerasDeVercel, cupoPorSesion } from "../config/base.js";

/** Pedidos rechazados por cupo. Que la corrida lo diga, no que lo esconda. */
export const rechazadosPorCupo = new Counter("rechazados_por_cupo");

/**
 * Las cuentas de prueba, separadas por coma.
 *
 * `LOAD_TEST_EMAIL` / `LOAD_TEST_PASSWORD` en singular siguen andando: son el
 * caso de una sola cuenta, que es el que hay hoy.
 */
function cuentas() {
  const correos = (__ENV.LOAD_TEST_EMAILS || __ENV.LOAD_TEST_EMAIL || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const claves = (__ENV.LOAD_TEST_PASSWORDS || __ENV.LOAD_TEST_PASSWORD || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (correos.length === 0 || claves.length === 0) {
    fail(
      "Faltan LOAD_TEST_EMAIL(S) / LOAD_TEST_PASSWORD(S).\n" +
        "  Sin sesión esto mide 401s: rápidos, verdes, y sin haber tocado la base."
    );
  }
  if (correos.length !== claves.length) {
    fail(`${correos.length} correo(s) y ${claves.length} clave(s). Tienen que ser tantos como tantos.`);
  }
  return correos.map((correo, i) => ({ correo, clave: claves[i] }));
}

/** Entra con una cuenta y devuelve la cabecera `Cookie` armada. */
function entrar({ correo, clave }) {
  const res = http.post(
    `${BASE_URL}/api/auth/sign-in/email`,
    JSON.stringify({ email: correo, password: clave }),
    {
      headers: { "Content-Type": "application/json", ...cabecerasDeVercel() },
      tags: { escenario: "login" },
    }
  );

  if (res.status !== 200) {
    /*
     * Un 401 con `Protected deployment` no es una credencial mala: es la puerta
     * de Vercel, que contesta antes de que el pedido llegue a la aplicación.
     * Decirlo cambia dónde busca el que lee el error.
     */
    const puerta = (res.body || "").includes("Protected deployment");
    fail(
      puerta
        ? "La vista previa está detrás de Deployment Protection y no hay llave. " +
            "Poné VERCEL_BYPASS con el secreto de automatización de Vercel."
        : `El login contestó ${res.status}. Sin sesión no hay nada que medir.`
    );
  }

  const cookies = res.cookies || {};
  const armada = Object.keys(cookies)
    .map((nombre) => `${nombre}=${cookies[nombre][0].value}`)
    .join("; ");
  if (!armada) fail("El login contestó 200 pero no dejó cookie.");
  return armada;
}

/**
 * Entra con TODAS las cuentas, una vez, antes de levantar los VUs.
 *
 * Avisa fuerte cuando los VUs pedidos no entran en el cupo que las cuentas
 * dan: es la diferencia entre «la aplicación aguanta 50 analistas» y «una
 * cuenta aguanta 100 pedidos por minuto», que es lo que se estaría midiendo.
 */
export function iniciarSesiones(vusPico, pedidosPorVuPorMinuto) {
  const lista = cuentas();
  const cookies = lista.map(entrar);

  const techo = lista.length * cupoPorSesion();
  const previsto = vusPico * pedidosPorVuPorMinuto;
  if (previsto > techo) {
    console.warn(
      `AVISO: ${vusPico} VUs harían ~${Math.round(previsto)} pedidos/min a /api/cases ` +
        `y ${lista.length} cuenta(s) dan ${techo}/min. Lo que sobra vuelve 429, ` +
        `así que esta corrida mide el limitador y no la aplicación. ` +
        `Sumá cuentas en LOAD_TEST_EMAILS/LOAD_TEST_PASSWORDS o bajá los VUs.`
    );
  }

  return { cookies, cuentas: lista.length };
}

/** Compatibilidad con el escenario que no necesita repartir: una sola sesión. */
export function iniciarSesion() {
  const { cookies } = iniciarSesiones(1, 0);
  return { cookie: cookies[0], cookies };
}

/**
 * Las cabeceras de un pedido autenticado, con la etiqueta del escenario.
 *
 * El reparto es `__VU % n`: cada VU usa siempre la misma cuenta, así que el
 * cupo se divide parejo en vez de que todos peguen contra el mismo balde.
 */
/**
 * @param extra  Etiquetas propias del escenario (la fase de la ola, el escalón).
 *               Están acá para que ningún escenario arme sus cabeceras a mano y
 *               se pierda el reparto de sesiones — que es exactamente lo que
 *               pasó: `spike` construía las suyas y se quedó sin cookie.
 */
export function comoAnalista(sesion, etiqueta = "lectura", extra = {}) {
  const lista = sesion.cookies || [sesion.cookie];
  const cookie = lista[(__VU - 1 + lista.length) % lista.length];
  return {
    headers: { Cookie: cookie, ...cabecerasDeVercel() },
    tags: { escenario: etiqueta, ...extra },
  };
}

/** Anota el 429 y devuelve si el pedido fue rechazado por cupo. */
export function esRechazoDeCupo(res) {
  if (res.status !== 429) return false;
  rechazadosPorCupo.add(1);
  return true;
}
