/**
 * Lo compartido por los seis escenarios: a dónde se pega, con qué presupuesto,
 * y qué NO se le hace a producción.
 *
 * ── El destino, y por qué no es producción por omisión ──────────────────────
 *
 * Esto corre sobre Vercel Hobby. Un `stress` de 200 VUs o un `spike` de 500
 * contra el deploy real no mide nada útil: mide el rate limiter de Vercel, se
 * come la cuota de invocaciones del mes y le tira la aplicación encima a quien
 * la esté usando. Es un ataque de denegación contra uno mismo con un nombre
 * más simpático.
 *
 * Así que el destino por omisión es local, y producción hay que pedirla. Y aun
 * pidiéndola, los perfiles pesados se niegan: contra producción sólo corren
 * `smoke` y `load`, que es lo que un deploy tiene que aguantar de todos modos.
 */

/** Lo que un tablero puede tardar antes de sentirse lento. Ver `scripts/load-test.mts`. */
export const PRESUPUESTO_P95_MS = 500;

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

/** `1` para dejar correr los perfiles pesados contra un destino que no es local. */
export const PERMITIR_REMOTO = __ENV.PERMITIR_REMOTO === "1";

/**
 * La llave para entrar a una vista previa protegida.
 *
 * Las vistas previas de Vercel están detrás de Deployment Protection, y eso no
 * es un 401 de la aplicación: es un 401 de Vercel, con
 * `{"error":{"message":"Protected deployment"}}`, ANTES de que el pedido llegue
 * a Next. Sin esto, medir contra una vista previa mide la puerta.
 *
 * Vercel da una llave para automatización justamente para esto. Va en cada
 * pedido, no sólo en el login: la protección se aplica a todos.
 */
const BYPASS = __ENV.VERCEL_BYPASS || "";

/** Las cabeceras que abren la puerta, o nada si no hay llave. */
export function cabecerasDeVercel() {
  if (!BYPASS) return {};
  return {
    "x-vercel-protection-bypass": BYPASS,
    // Que la primera respuesta deje la cookie y las siguientes no revaliden.
    "x-vercel-set-bypass-cookie": "true",
  };
}

const ES_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);

/**
 * Frena el escenario pesado que apunta afuera.
 *
 * Se llama al ARMAR las opciones, o sea antes de que k6 levante un solo VU: si
 * abortara adentro del `default`, ya habría mil pedidos en el aire.
 */
export function exigirDestinoSeguro(nombre) {
  if (ES_LOCAL || PERMITIR_REMOTO) return;
  throw new Error(
    `El escenario "${nombre}" no corre contra ${BASE_URL}.\n` +
      `  Es un perfil pesado y del otro lado hay un Hobby de Vercel: lo que mide es la\n` +
      `  cuota, y de paso se la gasta. Levantá la app local (pnpm dev) o, si de verdad\n` +
      `  querés apuntar afuera, PERMITIR_REMOTO=1 y hacete cargo.`
  );
}

/**
 * Los umbrales que comparten todos los escenarios.
 *
 * `http_req_failed` mira los que no llegaron. `http_req_duration` deja afuera
 * el tiempo de `setup()` porque ahí se hace el login, que es un pedido lento y
 * uno solo: promediarlo con diez mil lecturas corre el p95 hacia arriba por
 * algo que el analista no espera nunca.
 */
export function umbrales(extra = {}) {
  return {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{escenario:lectura}": [`p(95)<${PRESUPUESTO_P95_MS}`],
    ...umbralesComunes(),
    ...extra,
  };
}

/**
 * Las rutas que se miden, y de dónde salen.
 *
 * Todas verificadas contra el deploy: contestan 401 sin sesión, no 404. No hay
 * ninguna inventada, y no hay `/api/products` de ningún template.
 *
 * Sólo LECTURAS. Una prueba de carga que abre casos deja basura en la bandeja
 * de alguien, y contra producción le escribiría a personas reales; el intake se
 * ensaya por los canales simulados, que es lo que hace `pnpm rehearse`.
 */
export const RUTAS = {
  /** La bandeja. La sondea cada pestaña abierta cada 5-30 s: la más caliente. */
  bandeja: "/api/cases?page=1&per_page=50",
  /** El mismo listado con filtros puestos, que es como se usa de verdad. */
  bandejaFiltrada: "/api/cases?page=1&per_page=50&status=info_faltante",
  /** La búsqueda por texto, que no puede usar el índice del listado. */
  busqueda: "/api/cases?page=1&per_page=25&q=choque",
  /** Los KPI. Nueve consultas en un lote desde el PR #110. */
  metricas: "/api/metricas",
  /** El padrón. */
  clientes: "/api/customers?page=1&per_page=25",
  polizas: "/api/policies?page=1&per_page=25",
};

/**
 * Las que llevan el id de un caso.
 *
 * Aparte de `RUTAS` porque no se pueden pedir sin uno, pero acá igual: una ruta
 * armada a mano adentro de un escenario es la que sobrevive a un renombre y
 * mide 404s en silencio.
 */
export const RUTAS_DE_CASO = {
  detalle: (id) => `/api/cases/${id}`,
  mensajes: (id) => `/api/cases/${id}/messages`,
};


/**
 * Qué percentiles calcula k6 para el resumen.
 *
 * Por omisión son avg, min, med, max, p(90) y p(95) — el p(99) NO está. El
 * reporte lo publicaba igual y salía `null` en cada corrida: un campo que
 * siempre miente es peor que un campo que falta, porque se lee como «la cola
 * está bien».
 *
 * Y la cola es justo lo que importa acá: el p95 esconde a uno de cada veinte
 * analistas esperando, que en una mesa de cincuenta son dos personas por vuelta.
 */
export const PERCENTILES = ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"];

/** Cuánto espera un analista entre dos acciones. La bandeja sondea cada 5 s. */
export const PAUSA_S = 5;

/**
 * Cuántos pedidos por minuto aguanta UNA sesión contra `/api/cases`.
 *
 * Es `RATE_LIMIT_CONFIGS.CASES_API` del producto: 100 por minuto, con la clave
 * POR USUARIO. Y las tres rutas más pesadas de la mezcla comparten esa
 * etiqueta, o sea el mismo balde.
 *
 * Está acá para que los escenarios avisen cuando los VUs que piden no entran
 * en las cuentas que hay. Si allá cambia, acá también.
 */
export function cupoPorSesion() {
  return Number(__ENV.CUPO_POR_SESION || 100);
}

/**
 * Los umbrales que TODO escenario comparte, aparte de los suyos.
 *
 * `checks: rate==1.00` es el que faltaba y el que más importa: sin él, un
 * `check()` que falla no falla NADA. Con la API contestando 307 hacia `/login`
 * y el login devolviendo un HTML 200, el smoke salía verde con la mitad de los
 * checks en rojo, midiendo la pantalla de login.
 *
 * `rechazados_por_cupo` es la otra mitad: una corrida que se comió el cupo
 * tiene que decir eso, y no «la aplicación se cae con cincuenta analistas».
 */
export function umbralesComunes(maxRechazos = 0) {
  return {
    checks: ["rate==1.00"],
    rechazados_por_cupo: [`count<=${maxRechazos}`],
  };
}
