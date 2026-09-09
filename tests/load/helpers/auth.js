/**
 * Una sesión para todos los VUs, y por qué no una por VU.
 *
 * El login tiene tope: cinco intentos cada diez segundos por IP y correo. Es la
 * defensa contra el rociado de contraseñas y está bien que esté. Con doscientos
 * VUs logueándose cada uno, lo que se mide es ese tope: al sexto pedido empieza
 * a contestar 429 y la corrida entera reporta «el login está roto».
 *
 * Ya pasó con Playwright — catorce tests, nueve logins, los tests comiéndose su
 * propio cupo— y el arreglo fue el mismo: entrar una vez y compartir la cookie.
 * Ver `tests/e2e/auth.setup.ts`.
 *
 * `setup()` de k6 corre UNA vez, antes de levantar los VUs, y lo que devuelve
 * llega a cada iteración. Es exactamente el lugar.
 *
 * La cookie se manda a mano en cada pedido en vez de dejarla en el jar del VU:
 * el jar es por VU y `setup()` corre en otro contexto, así que lo que se
 * comparte tiene que ser el valor.
 */

import http from "k6/http";
import { fail } from "k6";

import { BASE_URL, cabecerasDeVercel } from "../config/base.js";

/**
 * Entra con el usuario de pruebas y devuelve la cabecera `Cookie` armada.
 *
 * Por `/api/auth/sign-in/email`, que es el handler de Better Auth montado en
 * `/api/auth/[...all]` — verificado contra el deploy: contesta 401 con
 * credenciales malas, no 404.
 *
 * Sin credenciales NO se sigue en silencio. Una corrida sin sesión mide 401s:
 * son rápidos, no fallan el umbral de latencia, y el reporte sale verde sin
 * haber tocado una sola consulta.
 */
export function iniciarSesion() {
  const correo = __ENV.LOAD_TEST_EMAIL;
  const clave = __ENV.LOAD_TEST_PASSWORD;

  if (!correo || !clave) {
    fail(
      "Faltan LOAD_TEST_EMAIL / LOAD_TEST_PASSWORD.\n" +
        "  Sin sesión esto mide 401s: rápidos, verdes, y sin haber tocado la base."
    );
  }

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

  return { cookie: armada };
}

/** Las cabeceras de un pedido autenticado, con la etiqueta del escenario. */
export function comoAnalista(sesion, etiqueta = "lectura") {
  return {
    headers: { Cookie: sesion.cookie, ...cabecerasDeVercel() },
    tags: { escenario: etiqueta },
  };
}
