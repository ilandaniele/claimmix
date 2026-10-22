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

/**
 * Las cabeceras que abren la puerta, o nada si no hay llave.
 *
 * Va la llave y nada más. Acá iba también `x-vercel-set-bypass-cookie: true`,
 * que Vercel documenta así: deja la autorización como cookie «using a redirect
 * with a Set-Cookie header». Un redirect, y en el POST del login.
 *
 * k6 sigue ese redirect mandando las MISMAS cabeceras, con lo cual la respuesta
 * siguiente vuelve a redirigir para dejar la cookie de nuevo, y así hasta
 * agotar `maxRedirects`. Lo que le llega a `entrar()` no es la sesión: es el
 * 307, y el error que sale —«El login contestó 307. Sin sesión no hay nada que
 * medir.»— manda a buscar el problema al login, que no tiene ninguno.
 *
 * La cookie era una comodidad para un navegador, que la reenvía solo. Acá no
 * hace falta: esta función se llama en cada pedido y la llave viaja en todos.
 */
export function cabecerasDeVercel() {
  if (!BYPASS) return {};
  return { "x-vercel-protection-bypass": BYPASS };
}

/** Como `comoAnalista` pero sin sesión: nadie arma sus cabeceras a mano. */
export function comoVisitante(tags = {}) {
  return {
    headers: cabecerasDeVercel(),
    tags: { escenario: "publico", ...tags },
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
 * El selector de las submétricas de lectura: lo que mira cada umbral y lo que
 * lee el reporte, para que hablen del mismo número.
 *
 * Con `fase`, sólo cuentan los pedidos de esa fase (`plano`, `despues`…).
 */
export function selectorDeLectura(fase = null) {
  return fase ? `escenario:lectura,fase:${fase}` : "escenario:lectura";
}

/**
 * Los umbrales de las LECTURAS, que son lo que se mide.
 *
 * Miran `{escenario:lectura}` y no el global: el login de `setup()` es un
 * pedido lento y uno solo, y promediarlo con diez mil lecturas corre el p95
 * hacia arriba por algo que el analista no espera nunca. Si el login falla,
 * `entrar()` corta la corrida antes de medir nada.
 *
 * Con `fase`, además, sólo cuenta esa fase. Las rampas mezclan pocos usuarios
 * con muchos y bajan el p95: un verde armado con ellas no dice nada de la carga
 * que se fue a probar.
 *
 * `http_reqs … count>0` es la guarda de que la fase se alcanzó: en k6 un umbral
 * sobre una submétrica SIN muestras pasa, y una meseta que nunca llegó saldría
 * verde. Además hace que el reporte tenga el conteo de pedidos de la lectura.
 */
export function umbralesDeLectura(fase = null) {
  const selector = selectorDeLectura(fase);
  return {
    [`http_req_failed{${selector}}`]: ["rate<0.01"],
    [`http_req_duration{${selector}}`]: [`p(95)<${PRESUPUESTO_P95_MS}`],
    [`http_reqs{${selector}}`]: ["count>0"],
  };
}

/** Los umbrales que comparten los escenarios que miden una carga pareja. */
export function umbrales(extra = {}, fase = null) {
  return {
    ...umbralesDeLectura(fase),
    ...umbralesComunes(),
    ...extra,
  };
}

/**
 * Un pedido al listado de casos. `filtros` va armado y sin el `&` del principio
 * (`status=info_faltante`). Los escenarios no escriben `/api/cases?…` a mano.
 */
export function listado(porPagina, filtros = "") {
  return `/api/cases?page=1&per_page=${porPagina}${filtros ? `&${filtros}` : ""}`;
}

/**
 * Las rutas que se miden, y de dónde salen.
 *
 * Todas verificadas contra el deploy: contestan 401 sin sesión, no 404. No hay
 * ninguna inventada, y no hay `/api/products` de ningún template. Un test
 * (`tests/unit/carga-constantes.test.ts`) comprueba que cada una exista en
 * `src/app`.
 *
 * Sólo LECTURAS. Una prueba de carga que abre casos deja basura en la bandeja
 * de alguien, y contra producción le escribiría a personas reales; el intake se
 * ensaya por los canales simulados, que es lo que hace `pnpm rehearse`.
 */
export const RUTAS = {
  /**
   * La bandeja. La sondea cada pestaña abierta cada 5-30 s: la más caliente.
   * Pide de a 100, como `useCasesRealtime` (`POR_PEDIDO`); el tope del listado.
   */
  bandeja: listado(100),
  /** El mismo listado con filtros puestos, que es como se usa de verdad. */
  bandejaFiltrada: listado(100, "status=info_faltante"),
  /** La búsqueda por texto, que no puede usar el índice del listado. */
  busqueda: listado(25, "q=choque"),
  /** Los KPI. Nueve consultas en un lote desde el PR #110. */
  metricas: "/api/metricas",
  /** El padrón. */
  clientes: "/api/customers?page=1&per_page=25",
  polizas: "/api/policies?page=1&per_page=25",
};

/**
 * Las páginas que el middleware sirve sin leer la sesión, o sea las que
 * contestan con la base de datos caída. Ver `src/proxy.ts:30,40,53-55`.
 */
export const RUTAS_PUBLICAS = ["/privacy", "/demo", "/terms", "/restablecer"];

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

/**
 * Cuánto espera un analista entre dos acciones.
 *
 * Cinco segundos es el piso del sondeo de la bandeja (`POLL_MIN_MS` en
 * `useCasesRealtime`); con la bandeja quieta el intervalo sube hasta 30 s. Se
 * mide el peor caso a propósito: es el que más gasta el cupo y el que más carga
 * tiene el servidor. No se le agrega un backoff al azar, que aliviaría
 * justamente lo que se fue a medir.
 */
export const PAUSA_S = 5;

/**
 * Cuántos pedidos por minuto aguanta UNA sesión contra `/api/cases`.
 *
 * Es `RATE_LIMIT_CONFIGS.CASES_API` del producto: 100 por minuto, con la clave
 * POR USUARIO Y POR RUTA (`user:<id>:<etiqueta>`): `cases-list`, `cases-get` y
 * `cases-messages-get` tienen cada una su balde. Los escenarios pasan a
 * `iniciarSesiones` los pedidos por minuto del balde más cargado, o los de
 * todas las rutas juntas si no las separan: de más, nunca de menos.
 *
 * Está acá para que los escenarios corten cuando los VUs que piden no entran
 * en las cuentas que hay. `tests/unit/carga-constantes.test.ts` lo ata al
 * producto: si allá cambia, el test avisa.
 */
export function cupoPorSesion() {
  return Number(__ENV.CUPO_POR_SESION || 100);
}

/**
 * Logins por minuto que el producto deja pasar desde una misma IP
 * (`RATE_LIMIT_CONFIGS.AUTH_POR_IP`), y desde una máquina de k6 salen todos de
 * la misma. Atado al producto por el mismo test que `cupoPorSesion`.
 */
export const TOPE_LOGIN_POR_MIN = 30;

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
 *
 * Van sueltos para el escenario que tolera fallos a propósito (`stress`,
 * `spike`): cambia la mitad de `checks` y se queda con la del cupo.
 */
export const CHECKS_SIN_FALLAS = ["rate==1.00"];

export function cupoSinRechazos(maxRechazos = 0) {
  return { rechazados_por_cupo: [`count<=${maxRechazos}`] };
}

export function umbralesComunes(maxRechazos = 0) {
  return { checks: CHECKS_SIN_FALLAS, ...cupoSinRechazos(maxRechazos) };
}
