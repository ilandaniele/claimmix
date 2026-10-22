/**
 * Qué difiere entre dev, QA y prd en las `banderas` de `/api/health`.
 *
 * Vive aparte del guión que pide las tres respuestas porque es la parte que se
 * equivoca sola y no se puede probar pegándole a los ambientes. Sin red y sin
 * dependencias: la importan `scripts/paridad.mjs` y su test.
 *
 * Los logs y el resumen de Actions son públicos (el repo lo es). Con `sinValores`
 * sólo sale la clave, el tipo de diferencia y QUÉ ambientes coinciden (`dev=qa≠prd`),
 * nunca el valor. Corrido a mano se ven los valores.
 *
 * Una clave da a lo sumo un hallazgo; gana el primero de esta lista:
 *   no-esperado  un valor fuera del contrato de `banderas.ts`
 *   falta        la clave está en unos ambientes y en otros no (otro código)
 *   desconocido  un modo que el código no reconoce, aunque coincida en los tres
 *   regla        rompe su fila de EXCEPCIONES (y una clave con excepción no da más)
 *   omision      uno rige por omisión (null) y otro tiene un número
 *   difiere      cualquier otra desigualdad
 */

import { HOST_DEV, HOST_QA, hostNormalizado } from "./hosts-vetados.mjs";

export const AMBIENTES = Object.freeze(["dev", "qa", "prd"]);

/** Lo que `leerRespuesta` pone en lugar de un valor que no cumple el contrato. */
export const NO_ESPERADO = "no-esperado";

const CLAVE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MODO = /^[a-z][a-z-]{0,20}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
// Hoy son 46: el tope sólo evita que un cuerpo ajeno llene el log.
const MAX_CLAVES = 200;

/** @param {any} x */
function congelar(x) {
  if (x && typeof x === "object") for (const v of Object.values(x)) congelar(v);
  return Object.freeze(x);
}

/**
 * Lo que puede quedar distinto a propósito, con su motivo (los D son las decisiones
 * de la guía de puesta en marcha, en docs/). Una clave que figura acá nunca da `difiere`: o
 * cumple su regla o da `regla`.
 * - fijo: el valor de cada ambiente es el de la tabla.
 * - entre: esos ambientes coinciden entre sí; el resto queda libre.
 * - implica-apagada: si la clave está en true, `de` tiene que estar en false en ese ambiente.
 */
export const EXCEPCIONES = congelar({
  BASE_POR_CLIENTE: {
    regla: "fijo",
    valores: { dev: false, qa: false, prd: true },
    motivo: "D2: prd con una base por cliente, dev y QA con una sola",
  },
  MONTHLY_BUDGET_USD: {
    regla: "entre",
    ambientes: ["dev", "qa"],
    motivo: "D7: dev y QA iguales entre sí (ahí gasta el ensayo), prd libre",
  },
  AI_TENANT_DAILY_TOKEN_CAP: {
    regla: "entre",
    ambientes: ["dev", "qa"],
    motivo: "D7: dev y QA iguales entre sí (ahí gasta el ensayo), prd libre",
  },
  SIGNUP_ALLOWED_EMAILS: {
    regla: "implica-apagada",
    de: "ALTA_AUTOMATICA",
    motivo: "D6: la lista sólo donde no hay alta automática; con ella en 1 tapa la prueba de autoalta",
  },
});

/** @param {unknown} x @returns {x is Record<string, unknown>} */
const esObjeto = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

/** @param {unknown} v */
function valorLegible(v) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : NO_ESPERADO;
  if (typeof v === "string" && MODO.test(v)) return v;
  return NO_ESPERADO;
}

/**
 * @typedef {boolean | number | string | null} Valor
 * @typedef {{ legible: true, banderas: Record<string, Valor>, commit: string }
 *   | { legible: false, motivo: string }} Lectura
 */

/**
 * Lo que dejó pasar `/api/health` de un ambiente. Sólo lee `banderas` y `commit`, y
 * sólo lo que cumple el contrato: nada más del cuerpo se copia, ni al motivo.
 *
 * @param {number | null} codigo  el código HTTP; 0 o null si no contestó
 * @param {unknown} cuerpo        el JSON, o null si no se pudo parsear
 * @returns {Lectura}
 */
export function leerRespuesta(codigo, cuerpo) {
  if (codigo === 401) return { legible: false, motivo: "sin permiso (401)" };
  if (!Number.isInteger(codigo) || /** @type {number} */ (codigo) < 100 || /** @type {number} */ (codigo) > 599) {
    return { legible: false, motivo: "sin respuesta" };
  }
  if (codigo !== 200 && codigo !== 503) return { legible: false, motivo: `HTTP ${codigo}` };

  const banderas = esObjeto(cuerpo) ? cuerpo.banderas : null;
  if (!esObjeto(banderas)) return { legible: false, motivo: "sin banderas" };

  /** @type {Record<string, Valor>} */
  const limpias = {};
  for (const [clave, valor] of Object.entries(banderas).slice(0, MAX_CLAVES)) {
    if (CLAVE.test(clave)) limpias[clave] = valorLegible(valor);
  }
  const commit = esObjeto(cuerpo) ? cuerpo.commit : null;
  return {
    legible: true,
    banderas: limpias,
    commit: typeof commit === "string" && COMMIT.test(commit) ? commit : "?",
  };
}

/**
 * El commit (7 hex, como lo informa `/api/health`) que tiene que estar sirviendo el
 * ambiente recién desplegado, o null si `sha` no es uno: entonces no se espera nada.
 *
 * @param {string | undefined} sha
 * @returns {string | null}
 */
export function commitEsperado(sha) {
  const corto = String(sha ?? "").trim().slice(0, 7);
  return COMMIT.test(corto) ? corto : null;
}

/**
 * Lee un ambiente, esperando a que sirva `esperado` si se lo pide. Vercel mueve el
 * alias un momento DESPUÉS de avisar que el deploy salió: leer enseguida compara las
 * banderas del build anterior, y las variables sólo cambian con un deploy nuevo. Si
 * tras `intentos` lecturas sigue sirviendo otro commit, el ambiente queda ilegible
 * en vez de comparar datos viejos. Una lectura ilegible no se espera: otra
 * lectura no la arregla.
 *
 * @param {() => Promise<Lectura>} pedir  una lectura nueva del ambiente
 * @param {string | null} esperado        el commit que tiene que servir, o null si no importa
 * @param {{ intentos?: number, esperaMs?: number }} [opciones]  por omisión, unos 3 minutos
 *   como el smoke (`waitForCommit`)
 * @returns {Promise<Lectura>}
 */
export async function leerAmbiente(pedir, esperado, { intentos = 36, esperaMs = 5_000 } = {}) {
  for (let intento = 1; intento <= intentos; intento++) {
    const lectura = await pedir();
    if (!esperado || !lectura.legible || lectura.commit === esperado) return lectura;
    if (intento < intentos) await new Promise((r) => setTimeout(r, esperaMs));
  }
  return { legible: false, motivo: "no sirve todavía el commit del deploy" };
}

/** Los ambientes que coinciden, juntos: `dev=qa≠prd`. */
const textoDeGrupos = (/** @type {string[][]} */ grupos) => grupos.map((g) => g.join("=")).join("≠");

/**
 * @typedef {{ clave: string, tipo: string, detalle: string, motivo: string | null,
 *   valores: Record<string, Valor> }} Hallazgo
 * @typedef {{ hallazgos: Hallazgo[], ilegibles: { ambiente: string, motivo: string }[],
 *   commits: Record<string, string> }} Paridad
 */

/**
 * @param {Record<string, any>} lecturas  una `Lectura` por ambiente de AMBIENTES
 * @returns {Paridad}
 */
export function compararParidad(lecturas) {
  const legibles = AMBIENTES.filter((a) => lecturas[a]?.legible);
  const ilegibles = AMBIENTES.filter((a) => !lecturas[a]?.legible).map((a) => ({
    ambiente: a,
    motivo: lecturas[a]?.motivo ?? "sin respuesta",
  }));
  const commits = Object.fromEntries(legibles.map((a) => [a, lecturas[a].commit]));
  const claves = new Set(legibles.flatMap((a) => Object.keys(lecturas[a].banderas)));

  /** @type {Hallazgo[]} */
  const hallazgos = [];
  for (const clave of claves) {
    /** @type {Record<string, Valor>} */
    const valores = {};
    for (const a of legibles) {
      if (Object.hasOwn(lecturas[a].banderas, clave)) valores[a] = lecturas[a].banderas[clave];
    }
    const presentes = legibles.filter((a) => a in valores);

    /** @param {string} tipo @param {string} detalle @param {string | null} [motivo] @returns {Hallazgo} */
    const hallazgo = (tipo, detalle, motivo = null) => ({ clave, tipo, detalle, motivo, valores });

    const fuera = presentes.filter((a) => valores[a] === NO_ESPERADO);
    if (fuera.length > 0) {
      hallazgos.push(hallazgo("no-esperado", fuera.join(",")));
      continue;
    }

    const ausentes = legibles.filter((a) => !presentes.includes(a));
    if (ausentes.length > 0) {
      const conCommit = legibles.map((a) => `${a}=${commits[a]}`).join(" ");
      hallazgos.push(hallazgo("falta", `sin clave en ${ausentes.join(",")}; commits ${conCommit}`));
      continue;
    }

    const sinReconocer = presentes.filter((a) => valores[a] === "desconocido");
    if (sinReconocer.length > 0) {
      hallazgos.push(hallazgo("desconocido", sinReconocer.join(",")));
      continue;
    }

    const regla = /** @type {any} */ (EXCEPCIONES)[clave];
    if (regla) {
      /** @type {string[]} */
      let malos = [];
      if (regla.regla === "fijo") {
        malos = presentes.filter((a) => a in regla.valores && valores[a] !== regla.valores[a]);
      } else if (regla.regla === "entre") {
        const [x, y] = regla.ambientes;
        if (x in valores && y in valores && valores[x] !== valores[y]) malos = [x, y];
      } else if (regla.regla === "implica-apagada") {
        malos = presentes.filter((a) => valores[a] === true && lecturas[a].banderas[regla.de] === true);
      }
      if (malos.length > 0) {
        hallazgos.push(hallazgo("regla", regla.regla === "entre" ? malos.join("≠") : malos.join(","), regla.motivo));
      }
      continue;
    }

    if (presentes.length < 2) continue;
    /** @type {Map<string, string[]>} */
    const porValor = new Map();
    for (const a of presentes) {
      const k = JSON.stringify(valores[a]);
      porValor.set(k, [...(porValor.get(k) ?? []), a]);
    }
    if (porValor.size === 1) continue;

    const mezcla = presentes.some((a) => valores[a] === null) && presentes.some((a) => typeof valores[a] === "number");
    hallazgos.push(hallazgo(mezcla ? "omision" : "difiere", textoDeGrupos([...porValor.values()])));
  }

  return { hallazgos, ilegibles, commits };
}

/**
 * Nada que pueda cortar una anotación de Actions ni romper una tabla.
 * @param {string} texto
 */
const limpiar = (texto) =>
  String(texto)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/:{2,}/g, ":")
    .replace(/[%|]/g, "");

/** @param {Record<string, string>} commits */
const textoDeCommits = (commits) =>
  Object.entries(commits)
    .map(([a, c]) => `${a} ${c}`)
    .join(", ");

/**
 * Las líneas para Actions y el resumen en Markdown. Sin hallazgos ni ambientes
 * ilegibles no hay avisos, sólo una línea informativa con los commits.
 *
 * @param {Paridad} paridad
 * @param {{ sinValores?: boolean }} [opciones]  por omisión no muestra valores: el log es público
 * @returns {{ avisos: string[], resumen: string }}
 */
export function lineasDeParidad(paridad, { sinValores = true } = {}) {
  const { hallazgos, ilegibles, commits } = paridad;
  const conCommits = `commits: ${textoDeCommits(commits) || "ninguno"}`;

  if (hallazgos.length === 0 && ilegibles.length === 0) {
    return {
      avisos: [],
      resumen: limpiar(`Paridad de banderas: sin diferencias fuera de las excepciones (${conCommits}).`),
    };
  }

  const aviso = (/** @type {string} */ texto) => `::warning title=Paridad::${limpiar(texto)}`;
  const avisos = [
    ...ilegibles.map((i) => aviso(`${i.ambiente}: ilegible (${i.motivo})`)),
    ...hallazgos.map((h) => aviso(`${h.clave}: ${h.tipo} (${h.detalle})${h.motivo ? ` — ${h.motivo}` : ""}`)),
  ];

  const valoresDe = (/** @type {Hallazgo} */ h) =>
    AMBIENTES.filter((a) => a in h.valores)
      .map((a) => `${a}=${h.valores[a]}`)
      .join(" ");
  const columnas = sinValores ? ["Clave", "Hallazgo", "Dónde", "Motivo"] : ["Clave", "Hallazgo", "Dónde", "Valores", "Motivo"];
  const filas = hallazgos.map((h) => {
    const celdas = sinValores
      ? [h.clave, h.tipo, h.detalle, h.motivo ?? ""]
      : [h.clave, h.tipo, h.detalle, valoresDe(h), h.motivo ?? ""];
    return `| ${celdas.map(limpiar).join(" | ")} |`;
  });

  const lineas = ["### Paridad de banderas", ""];
  if (hallazgos.length > 0) {
    lineas.push(`| ${columnas.join(" | ")} |`, `|${columnas.map(() => "---").join("|")}|`, ...filas, "");
  }
  for (const i of ilegibles) lineas.push(`- ${limpiar(`${i.ambiente}: ilegible (${i.motivo})`)}`);
  if (ilegibles.length > 0) lineas.push("");
  lineas.push(limpiar(conCommits));

  return { avisos, resumen: lineas.join("\n") };
}

/**
 * El origen de prd, o null si `valor` no es uno: sólo https, sin credenciales ni
 * puerto ni ruta, y no el de dev ni el de QA. El Bearer de prd viaja a este origen
 * y a ningún otro.
 *
 * @param {string | undefined} valor
 * @returns {string | null}
 */
export function urlDePrd(valor) {
  let u;
  try {
    u = new URL(String(valor ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  const host = hostNormalizado(u.href);
  return host === HOST_DEV || host === HOST_QA ? null : u.origin;
}
