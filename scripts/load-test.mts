/**
 * scripts/load-test.mts
 *
 * Cuánto aguanta esto antes de que se note, y qué se rompe primero.
 *
 * El resto de la suite pregunta si el sistema hace lo correcto. Esto pregunta
 * otra cosa: si lo sigue haciendo cuando llegan treinta denuncias en dos
 * minutos. Es un escenario real y previsible — un granizo sobre una ciudad
 * mediana genera exactamente eso — y es el único modo de falla que no aparece
 * nunca mientras se programa, porque ahí siempre hay un solo usuario.
 *
 * Mide dos caminos, que se rompen por motivos distintos:
 *
 *   LECTURA — las consultas del tablero contra la base de verdad. Gratis, no
 *   escribe nada. Es lo que ve el analista mientras el resto arde, y lo que se
 *   degrada de a poco a medida que crece el volumen, sin que nadie lo note
 *   hasta que la pantalla tarda cinco segundos.
 *
 *   ESCRITURA — asegurados simultáneos entrando por el webhook del deploy de
 *   verdad. Cuesta plata: cada uno es una llamada real al modelo. Mide las dos
 *   latencias que importan y que no son la misma: cuánto tarda el webhook en
 *   contestarle a Meta (si se pasa, Meta reintenta y el asegurado recibe todo
 *   dos veces) y cuánto tarda en quedar registrada la respuesta al asegurado.
 *   Registrada, no entregada: el caso entra marcado como simulado, así que el
 *   mensajero redacta y guarda en vez de llamar a Graph. Ese último tramo no
 *   está adentro del número, y decirlo es parte del número.
 *
 * Sobre LECTURA hay cuatro formas, y cada una contesta una pregunta distinta.
 * Que sean cuatro y no una repetida con otro nombre es el punto: si las cuatro
 * miden el mismo p95 con otra etiqueta, tres son decoración.
 *
 *   carga        ¿cuánto tarda una consulta con la mesa llena?     p95 por nivel
 *   pico         ¿se recupera después de una ráfaga?               p95 después / antes
 *   resistencia  ¿se degrada sola con el tiempo?                   p95 final / inicial
 *   estres       ¿dónde está el techo?                             la concurrencia que rompe
 *
 * Nada le llega a una persona. El camino Bearer del webhook marca el caso como
 * simulado, así que el mensajero redacta la respuesta y la guarda en vez de
 * enviarla — igual que en el ensayo.
 *
 * Uso:
 *   pnpm load                        # forma «carga»: gratis, es la que corre en cada deploy
 *   pnpm load --forma pico           # ráfaga y recuperación, sobre lectura
 *   pnpm load --forma resistencia    # sostenida, 3 minutos (--minutos N)
 *   pnpm load --forma estres         # rampa hasta encontrar el techo
 *   pnpm load --forma todas          # las cuatro, a mano
 *   pnpm load --reporte carga.json   # escribe carga.json y carga.html
 *   pnpm load --write                # + 10 asegurados simultáneos (gasta tokens)
 *   pnpm load --write --claimants 30 # una tormenta de granizo
 *   pnpm load --url https://…        # contra un preview
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";

import type { ClienteDatos } from "@/data/scope";

import { findRoutes, routePattern } from "./lib/rutas-api.mjs";
import {
  fila,
  measure,
  measureFor,
  ms,
  porTiempo,
  razon,
  veces,
  type Sample,
} from "./lib/medir-carga.mjs";
import {
  escribirReporte,
  type Endpoint,
  type Fila,
  type Forma,
} from "./lib/reporte-carga.mjs";

const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

const TENANT_ID = process.env.GMAIL_TENANT_ID;
if (!process.env.DATABASE_URL || !TENANT_ID) {
  console.error("Faltan DATABASE_URL o GMAIL_TENANT_ID en .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : null;
}

function numero(name: string, porOmision: number, min: number, max: number): number {
  const valor = Number(flag(name) ?? porOmision);
  // Un `--p95 quinientos` que se vuelve NaN apaga el umbral sin decir nada:
  // toda comparación contra NaN es falsa y el chequeo sale verde.
  return Math.min(Math.max(Number.isFinite(valor) ? valor : porOmision, min), max);
}

const FORMAS = ["carga", "pico", "resistencia", "estres", "todas"] as const;
type NombreForma = (typeof FORMAS)[number];

const pedida = (flag("forma") ?? "carga") as NombreForma;
if (!FORMAS.includes(pedida)) {
  console.error(`--forma tiene que ser una de: ${FORMAS.join(", ")}`);
  process.exit(1);
}
const corren = (pedida === "todas" ? FORMAS.filter((f) => f !== "todas") : [pedida]) as Exclude<
  NombreForma,
  "todas"
>[];

const doWrite = args.includes("--write");
const claimants = numero("claimants", 10, 1, 100);
const reporte = flag("reporte");
const BASE = (flag("url") || process.env.SMOKE_URL || "https://claimmix.vercel.app").replace(
  /\/+$/,
  ""
);

// Importado después de dotenv: el módulo de base lee DATABASE_URL al importarse.
const { db } = await import("@/lib/db");
const { cases, outboundMessages, claimAttachments } = await import("@/lib/db/schema");
const { and, count, eq, inArray, like, sql } = await import("drizzle-orm");
const { enTenantVarias } = await import("@/data/scope");
const {
  consultaConteo,
  consultaListado,
  consultaPorEstado,
  contarPorEstado,
  listCases,
} = await import("@/server/cases/list");
const { getCaseDetail } = await import("@/server/cases/get");

/**
 * El inquilino, como lo recibe la aplicación.
 *
 * Todo lo que se MIDE entra por acá: `DATABASE_URL_APP`, rol `claimmix_app`, y
 * el filtro por inquilino puesto por RLS. `db` —`DATABASE_URL`, el dueño, con
 * BYPASSRLS— sólo se usa para lo que no es una consulta del producto: el
 * catálogo de índices y la limpieza de los casos que crea la ráfaga.
 */
const CTX = { tenantId: TENANT_ID! };

// ── Umbrales ─────────────────────────────────────────────────────────────────

/**
 * El techo del p95 de una consulta del tablero.
 *
 * Estaba en 2000 ms y eso no era un umbral: medido, esto corre entre 299 ms
 * (20 analistas, auditoría de agosto) y 391 ms (el tablero durante la
 * tormenta), así que la latencia podía empeorar cinco veces y el chequeo
 * seguía verde. 500 ms es el orden de lo medido con un poco de aire para la
 * red del runner, que no es la de la aplicación: el runner de GitHub le habla
 * a Neon desde afuera.
 *
 * Si un día el aire no alcanza, el knob es `--p95`, no borrar el chequeo.
 */
const P95_LECTURA_MS = numero("p95", 500, 50, 10_000);

/**
 * El techo del acuse del webhook.
 *
 * Es la latencia más cara del archivo y no tenía umbral: si el acuse tarda
 * demasiado, Meta reintenta y el asegurado recibe todo dos veces. Medido: 1,6 s
 * a 2,9 s de p95 entre 10 y 100 asegurados simultáneos. 5 s deja margen sobre
 * eso sin dejar pasar una duplicación de la latencia, que es exactamente lo que
 * empieza a disparar reintentos.
 */
const P95_ACUSE_MS = numero("acuse", 5_000, 500, 60_000);

/**
 * Cuánto puede empeorar el p95 después de una ráfaga (pico) o al final de una
 * corrida larga (resistencia) antes de que sea un problema y no ruido.
 *
 * 1,5× y no 1,0×: dos mediciones consecutivas de lo mismo difieren por el
 * planificador, por el caché y por la red. Lo que se busca acá no es una
 * diferencia, es que la diferencia NO se cierre — un sistema que después de la
 * ráfaga sigue lento es uno que no se recuperó.
 */
const EMPEORA_MAX = 1.5;

/** Muestras por celda. La MISMA cantidad en todas, en las cuatro formas.
 *
 * Eran `concurrencia * 3`, o sea TRES con un analista, y `percentile(…, 95)`
 * sobre tres valores devuelve el máximo: no era un p95, era el peor de tres.
 * Con 120 el p95 es la muestra 114 y un hipo aislado de Neon deja de moverlo
 * entero. Cuesta alrededor de un minuto de corrida.
 *
 * Que sea la misma en todas las celdas es la otra mitad, y faltaba: el estrés
 * usaba `nivel * 4` —20 muestras a 5 simultáneos, 320 a 80— así que el p95 era
 * el segundo peor de veinte abajo y un p95 de verdad arriba. El sesgo del
 * estimador cambiaba justo a lo largo del eje que la rampa compara, y con él
 * el techo que reporta. Pico y escritura tenían el mismo problema con 40 y 20
 * muestras para «antes» y «después», que es un cociente entre dos casi-máximos
 * decidido contra un umbral de 1,5×.
 */
const MUESTRAS = numero("muestras", 120, 20, 5_000);

/**
 * Cuánto dura la resistencia.
 *
 * Las plantillas piden dos horas. Dos horas contra la base que atiende
 * asegurados de verdad no es una prueba, es carga sostenida sobre producción, y
 * nadie la va a correr — o sea que en la práctica esa forma no existiría. Tres
 * minutos alcanzan para ver lo que la carga no ve: si el p95 del último tramo
 * se despega del primero, hay algo que se acumula (conexiones, memoria, filas
 * que crecen), y eso aparece temprano o no aparece.
 *
 * El tope de 30 es a propósito: más que eso ya no lo corre nadie.
 */
const MINUTOS = numero("minutos", 3, 1, 30);

/** La rampa del estrés, y la concurrencia que el producto dice aguantar. */
const NIVELES_ESTRES = [5, 10, 20, 40, 80];
const TECHO_EXIGIDO = 20;
const ROMPE_SI_TARDA = 4; // veces la línea de base

// ── Las rutas que esta prueba nombra ─────────────────────────────────────────

/**
 * Escritas acá con su archivo, y comprobadas contra `src/app/api` antes de
 * medir nada.
 *
 * La regla del dueño —no inventar endpoints— convertida en código en vez de en
 * disciplina. Sin esto, el día que alguien renombre el webhook la prueba se
 * entera con un 404 contado como falla de carga, que manda a buscar el problema
 * al lado equivocado.
 */
const ENDPOINTS: Omit<Endpoint, "existe">[] = [
  {
    metodo: "POST",
    ruta: "/api/webhooks/whatsapp",
    archivo: "src/app/api/webhooks/whatsapp/route.ts",
    auth: "Bearer WHATSAPP_WEBHOOK_SECRET",
    usa: "la ráfaga de escritura (--write)",
  },
  {
    metodo: "GET",
    ruta: "/api/health",
    archivo: "src/app/api/health/route.ts",
    auth: "Bearer CRON_SECRET",
    usa: "la sonda de vida durante resistencia y estrés",
  },
];

function verificarEndpoints(): Endpoint[] {
  const archivos = new Set(findRoutes("src/app/api").map((f) => f.replace(/\\/g, "/")));
  // Las dos mitades: que el archivo esté, y que la ruta declarada sea la que
  // ese archivo sirve. Si sólo se comprobara la ruta, `archivo` podría mentir.
  return ENDPOINTS.map((e) => ({
    ...e,
    existe: archivos.has(e.archivo) && routePattern(e.archivo) === e.ruta,
  }));
}

/**
 * Una sonda de vida al deploy, entre tramo y tramo.
 *
 * Sirve para distinguir dos cosas que en una tabla de latencias se ven iguales:
 * «se puso lento» y «se cayó». Pide autenticación (Bearer CRON_SECRET) y eso se
 * maneja de frente: sin la llave no se mide y se dice, y un 401 se reporta como
 * lo que es —una llave mal puesta— y no como una caída.
 */
let sondaNota: string | null = null;

async function sonda(): Promise<Sample | null> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    sondaNota = "Sonda de vida no medida: falta CRON_SECRET.";
    return null;
  }
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/health`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (res.status === 401 || res.status === 403) {
      sondaNota = `Sonda de vida no medida: /api/health contestó ${res.status}, la llave no sirve.`;
      return null;
    }
    /*
     * Un 503 de /api/health casi nunca es una caída por carga.
     *
     * El endpoint devuelve 503 cuando cualquiera de sus nueve chequeos queda en
     * «down»: un token de WhatsApp vencido, el presupuesto agotado, una
     * migración sin aplicar. Contarlos todos como caída ponía la prueba de
     * carga en rojo apuntando a la carga cuando lo que pasó fue que venció una
     * credencial — y el 503 por presupuesto agotado es, además, el estado en
     * que las latencias del camino de escritura salen preciosas y falsas.
     *
     * Los dos únicos que SÍ hablan de carga son la base y la capa de datos, así
     * que se miran esos dos y el resto se anota. Descartar el 503 entero
     * hubiera tapado justo el caso que importa: la base que deja de responder
     * porque la estamos apretando.
     */
    if (res.status === 503) {
      const cuerpo = (await res.json().catch(() => ({}))) as {
        checks?: Array<{ name?: string; status?: string; detail?: string }>;
      };
      const caidos = (cuerpo.checks ?? []).filter((c) => c.status === "down");
      const laBase = caidos.filter(
        (c) => c.name === "base de datos" || c.name === "capa de datos"
      );
      sondaNota =
        `/api/health contestó 503 (${caidos.map((c) => c.name).join(", ") || "sin detalle"}). ` +
        (laBase.length > 0
          ? "La base no responde: eso SÍ es una caída."
          : "El deploy contesta y la base también — no es una caída por carga, mirá `pnpm smoke`.");
      return { ms: performance.now() - t0, ok: laBase.length === 0 };
    }
    return { ms: performance.now() - t0, ok: res.ok };
  } catch {
    return { ms: performance.now() - t0, ok: false };
  }
}

// ── Los escenarios de lectura ────────────────────────────────────────────────

interface Escenario {
  name: string;
  run: () => Promise<void>;
}

const QUERY = { page: 1, per_page: 25, sort: "created_at", order: "desc" } as const;

/**
 * Los escenarios, y la comprobación de que haya algo que medir.
 *
 * El volumen se cuenta por la MISMA conexión que se mide y no por `db`: el
 * conteo del dueño decía «460 casos» mientras `listCases` —que entra por
 * `DATABASE_URL_APP` con RLS— podía estar devolviendo cero, y con cero filas el
 * trabajo desaparece: las tres subconsultas correlacionadas del listado son POR
 * FILA, y `getCaseDetail` corta en la primera consulta y se saltea las otras
 * tres. Ninguna tira, así que todo sale verde con un p95 de 40 ms sin haber
 * medido nada. Basta con que las dos cadenas apunten a ramas distintas de Neon,
 * o con que el inquilino no sea el dueño de las filas de esa base.
 */
async function prepararLectura(): Promise<{
  escenarios: Escenario[];
  casos: number;
  notas: string[];
}> {
  // Neon suspende la compute cuando nadie la usa, y la primera consulta después
  // paga el arranque. Sin este calentamiento el primer número mide eso y no la
  // carga, que es justo lo contrario de lo que se quiere saber.
  const primera = await listCases(CTX, { ...QUERY } as never);
  const casos = primera.meta.total;

  if (casos === 0 || primera.data.length === 0) {
    console.error(
      `El listado no devolvió ninguna fila para el inquilino ${TENANT_ID}.\n` +
        "Medir esto no diría nada: con cero filas el listado no ejecuta sus\n" +
        "subconsultas y el detalle corta en la primera consulta, así que sale\n" +
        "todo verde y rapidísimo sin haber medido nada.\n" +
        "Suele ser DATABASE_URL_APP apuntando a otra base que DATABASE_URL, o\n" +
        "un GMAIL_TENANT_ID que no es el dueño de las filas de ésa."
    );
    process.exit(1);
  }

  const notas: string[] = [];

  /*
   * El caso más viejo, y no el que la base tenga a mano.
   *
   * Era `select id from cases … limit 1` sin ORDER BY: Postgres devuelve la
   * fila que le queda cómoda, y eso cambia con updates, autovacuum o
   * crecimiento de la tabla. Un caso con veinte adjuntos no cuesta lo que uno
   * vacío, y este trabajo compara contra un umbral absoluto y contra el
   * artefacto del deploy anterior: dos corridas midiendo casos distintos leen
   * como una regresión del código.
   */
  const masViejo = await listCases(CTX, {
    ...QUERY,
    per_page: 1,
    order: "asc",
  } as never);
  const someCase = masViejo.data[0]?.id ?? null;

  const escenarios: Escenario[] = [
    {
      // Lo que cuesta abrir la bandeja, entero: el listado con LIMIT 25 y los
      // contadores por estado, que son un agregado SIN límite sobre toda la
      // tabla del inquilino. Medir sólo `listCases` era medir la mitad que no
      // se va a romper y dejar afuera la que sí.
      name: "bandeja (listado + contadores)",
      run: async () => {
        await Promise.all([listCases(CTX, { ...QUERY } as never), contarPorEstado(CTX)]);
      },
    },
    {
      name: "búsqueda por texto",
      run: async () => {
        await listCases(CTX, { ...QUERY, q: "gonzalez" } as never);
      },
    },
  ];

  if (someCase && (await getCaseDetail(TENANT_ID!, someCase))) {
    escenarios.push({
      name: "detalle de un caso",
      run: async () => {
        await getCaseDetail(TENANT_ID!, someCase);
      },
    });
    notas.push("El detalle mide siempre el caso más viejo, para que dos corridas se comparen.");
  } else if (someCase) {
    notas.push("El detalle no se midió: el caso más viejo del listado no se pudo leer.");
  }

  return { escenarios, casos, notas };
}

/**
 * Lo que estas cuatro formas NO miden, dicho una vez.
 *
 * Llaman a `listCases` y `getCaseDetail` como funciones, no por HTTP. Eso aísla
 * la base, que es lo que hace falta para cazar la regresión de índice, y deja
 * afuera tres cosas que en producción pegan ANTES que la consulta: la
 * resolución de sesión, el limitador (que también consulta Postgres, en el
 * camino caliente) y el arranque en frío de la función.
 *
 * La versión por HTTP no se agrega de prepo porque necesita N sesiones y no
 * una: 20 analistas simultáneos sobre una misma cuenta agotan CASES_API
 * (100/min) en unos diez segundos, y a partir de ahí se estaría midiendo el
 * limitador y llamándolo latencia.
 */
const AVISO_FUNCION =
  "Medido como función contra la base: no incluye sesión, limitador ni arranque en frío, " +
  "y sí incluye el viaje de red de esta máquina a Neon, que la aplicación en Vercel no paga.";

// ── Forma 1: carga ───────────────────────────────────────────────────────────

/**
 * La mesa llena, a una concurrencia realista y sostenida.
 *
 * 1, 5 y 20 analistas: una mesa de siniestros son decenas de personas, no
 * quinientos usuarios virtuales. Contesta una sola pregunta —cuánto tarda una
 * consulta cuando el resto también está consultando— y es la única de las
 * cuatro que corre en cada deploy.
 */
async function formaCarga(escenarios: Escenario[]): Promise<Forma> {
  const ANCHO = 30;
  console.log("─".repeat(68));
  console.log("CARGA — el tablero con la mesa llena. Gratis, no escribe nada.\n");
  console.log(" ".repeat(ANCHO) + "analistas simultáneos (p95)");
  console.log("consulta".padEnd(ANCHO) + ["1", "5", "20"].map((n) => n.padStart(9)).join(""));
  console.log("─".repeat(68));

  const filas: Fila[] = [];
  let peor = 0;
  let fallaron = 0;
  let ok = true;

  for (const escenario of escenarios) {
    const cells: string[] = [];
    for (const concurrency of [1, 5, 20]) {
      const samples = await measure(MUESTRAS, concurrency, escenario.run);
      const f = fila(`${escenario.name} · ${concurrency} analistas`, samples);
      filas.push(f);
      if (f.fallaron > 0) {
        // El p95 de una celda que falló es el de los sobrevivientes, y entraba
        // igual al titular «p95 peor caso» del reporte, donde se lee como si
        // fuera el de una celda sana. La celda se cuenta por lo que falló.
        ok = false;
        fallaron += f.fallaron;
        cells.push(`${f.fallaron} ✗`.padStart(9));
      } else {
        peor = Math.max(peor, f.p95);
        if (f.p95 > P95_LECTURA_MS) ok = false;
        cells.push(ms(f.p95).padStart(9));
      }
    }
    console.log(escenario.name.padEnd(ANCHO) + cells.join(""));
  }

  console.log(`\np95: de cada 20 consultas, 19 tardan menos que esto. ${MUESTRAS} por celda.`);
  console.log(`Presupuesto: ${ms(P95_LECTURA_MS)}. Más que eso el tablero se siente lento.`);

  return {
    nombre: "carga",
    pregunta: "¿Cuánto tarda una consulta del tablero con la mesa llena?",
    metrica: "el peor p95 entre 1, 5 y 20 analistas simultáneos",
    umbral: `p95 < ${ms(P95_LECTURA_MS)} y ninguna consulta fallada`,
    medido:
      `p95 peor caso ${ms(peor)}` +
      (fallaron > 0 ? ` · ${fallaron} consulta(s) fallada(s), sin p95 comparable` : ""),
    ok,
    filas,
    notas: [AVISO_FUNCION],
  };
}

// ── Forma 2: pico ────────────────────────────────────────────────────────────

/**
 * La ráfaga, y lo que pasa DESPUÉS de la ráfaga.
 *
 * Un pico sin línea de base ni recuperación mide la ráfaga, no el pico. Lo que
 * distingue a esta forma de la carga es la última medición: un sistema que
 * aguanta cuarenta consultas de golpe y queda lento cuando la ola pasó tiene un
 * problema que la carga sostenida no puede ver.
 */
async function formaPico(escenario: Escenario): Promise<Forma> {
  const CONCURRENCIA = 40;

  console.log("\n" + "─".repeat(68));
  console.log(`PICO — ${CONCURRENCIA} consultas de golpe sobre «${escenario.name}».\n`);

  const antes = fila("antes (1 analista)", await measure(MUESTRAS, 1, escenario.run));
  const rafaga = fila(
    `ráfaga (${CONCURRENCIA} a la vez)`,
    await measure(MUESTRAS, CONCURRENCIA, escenario.run)
  );
  const despues = fila("después (1 analista)", await measure(MUESTRAS, 1, escenario.run));

  const recuperacion = veces(antes.p95, despues.p95);
  // `antes.fallaron` también: si la línea de base se cayó entera su p95 es 0, y
  // sin este término la forma imprimía «1,00× el de antes» —el mejor resultado
  // posible— sobre una comparación que no existió.
  const ok =
    antes.fallaron === 0 &&
    rafaga.fallaron === 0 &&
    despues.fallaron === 0 &&
    recuperacion <= EMPEORA_MAX;

  for (const f of [antes, rafaga, despues]) {
    console.log(
      `  ${f.etiqueta.padEnd(24)} p95 ${ms(f.p95).padStart(7)}   fallaron ${f.fallaron}`
    );
  }
  console.log(`\n  Recuperación: el p95 después quedó en ${razon(recuperacion)} el de antes.`);

  return {
    nombre: "pico",
    pregunta: "¿Vuelve a la normalidad cuando la ráfaga pasó?",
    metrica: "p95 después de la ráfaga dividido por el p95 de antes",
    umbral: `≤ ${EMPEORA_MAX}× y ninguna consulta fallada, ni en la ráfaga ni en la base`,
    medido: `${razon(recuperacion)} · ráfaga p95 ${ms(rafaga.p95)}, ${rafaga.fallaron} fallada(s)`,
    ok,
    filas: [antes, rafaga, despues],
    notas: [
      AVISO_FUNCION,
      `Las tres miden ${MUESTRAS} consultas: un cociente de p95 con distinto tamaño de muestra ` +
        "compara dos estimadores distintos y no dos sistemas.",
    ],
  };
}

// ── Forma 3: resistencia ─────────────────────────────────────────────────────

/**
 * La misma carga moderada, sostenida, mirando si se degrada sola.
 *
 * No mide latencia: mide DERIVA. La carga contesta «tarda 300 ms»; ésta
 * contesta «al final tarda lo mismo que al principio», que es otra pregunta y
 * la única que ve lo que se acumula — conexiones que no se devuelven, memoria,
 * un plan que se degrada a medida que la tabla crece durante la corrida.
 *
 * Lo que NO ve, dicho para que nadie la lea de más: el autosuspend de Neon
 * necesita que nadie use la base, y acá alguien la usa todo el tiempo. Eso lo
 * mide el primer request después de un rato de silencio, no esto.
 */
async function formaResistencia(escenario: Escenario, minutos: number): Promise<Forma> {
  const CONCURRENCIA = 5;

  console.log("\n" + "─".repeat(68));
  console.log(
    `RESISTENCIA — ${CONCURRENCIA} analistas durante ${minutos} min sobre «${escenario.name}».\n`
  );

  const vida: Sample[] = [];
  const fin = performance.now() + minutos * 60_000;

  // La sonda corre en paralelo a la carga, no entre medio: preguntarle al
  // deploy si está vivo mientras la base está ocupada es justo el momento en
  // que la respuesta importa.
  const latido = (async () => {
    while (performance.now() < fin) {
      await new Promise((r) => setTimeout(r, 15_000));
      const s = await sonda();
      if (s) vida.push(s);
      const restante = Math.max(0, Math.round((fin - performance.now()) / 1000));
      process.stdout.write(`\r  faltan ${restante}s…    `);
    }
  })();

  const samples = await measureFor(minutos * 60_000, CONCURRENCIA, escenario.run);
  await latido;
  console.log("");

  // Por reloj y no por posición en el arreglo: ver `porTiempo`.
  const [t1, t2, t3] = porTiempo(samples, 3);
  const primero = fila("primer tercio", t1 ?? []);
  const medio = fila("tercio del medio", t2 ?? []);
  const ultimo = fila("último tercio", t3 ?? []);

  const deriva = veces(primero.p95, ultimo.p95);
  const filas = [primero, medio, ultimo];
  if (vida.length > 0) filas.push(fila("sonda /api/health", vida));

  const caidas = vida.filter((s) => !s.ok).length;
  const ok =
    deriva <= EMPEORA_MAX &&
    samples.every((s) => s.ok) &&
    caidas === 0 &&
    primero.medidas > 0 &&
    ultimo.medidas > 0;

  for (const f of filas) {
    console.log(
      `  ${f.etiqueta.padEnd(24)} p95 ${ms(f.p95).padStart(7)}   ${f.muestras} muestras   fallaron ${f.fallaron}`
    );
  }
  console.log(`\n  Deriva: el último tercio quedó en ${razon(deriva)} el primero.`);

  const notas = [AVISO_FUNCION, "El autosuspend de Neon no aparece acá: necesita silencio, no carga."];
  if (sondaNota) notas.push(sondaNota);

  /*
   * El umbral dice lo que se comprobó, y nada más.
   *
   * Sin CRON_SECRET la sonda devuelve null, `vida` queda vacío, `caidas` da 0 y
   * el término se cumple solo — y la forma publicaba «sin caídas de la sonda»
   * como umbral cumplido sin haberla tomado una vez. El post-deploy no le pasa
   * CRON_SECRET al trabajo de carga, así que ése es el modo por omisión.
   */
  const conSonda = vida.length > 0;

  return {
    nombre: "resistencia",
    pregunta: "¿Se degrada sola cuando la carga se sostiene?",
    metrica: "p95 del último tercio dividido por el del primero",
    umbral:
      `≤ ${EMPEORA_MAX}× y sin consultas falladas` +
      (conSonda ? ", y sin caídas de la sonda" : " (la sonda de vida no se midió)"),
    medido:
      `${razon(deriva)} en ${minutos} min · ${samples.length} consultas` +
      (conSonda ? ` · ${caidas} caída(s) de la sonda` : " · sin sonda"),
    ok,
    filas,
    notas,
  };
}

// ── Forma 4: estrés ──────────────────────────────────────────────────────────

/**
 * Subir hasta que rompa, y decir dónde rompió.
 *
 * Es la única de las cuatro que no busca un verde: busca un número. Las otras
 * tres preguntan «¿aguanta lo que le pedimos?»; ésta pregunta «¿cuánto más hay
 * antes del borde?», y sin ella la frase «el límite no es el código» es una
 * afirmación del documento y no un resultado de la herramienta.
 *
 * Falla sólo si el techo aparece por debajo de lo que el producto promete
 * aguantar. Un techo alto no es una falla; no encontrarlo tampoco — quiere
 * decir que está más arriba de donde se buscó.
 */
async function formaEstres(escenario: Escenario, max: number): Promise<Forma> {
  console.log("\n" + "─".repeat(68));
  console.log(`ESTRÉS — rampa sobre «${escenario.name}» hasta que se note.\n`);

  const base = fila("línea de base (1 analista)", await measure(MUESTRAS, 1, escenario.run));
  const filas: Fila[] = [base];
  let techo = 0;
  let rompio: string | null = null;

  if (base.fallaron > 0 || base.p95 <= 0) {
    console.log("  La línea de base falló: sin ella el corte compara contra nada.");
    return {
      nombre: "estres",
      pregunta: "¿Dónde está el techo, y qué se rompe primero al llegar?",
      metrica: "la concurrencia más alta que todavía responde como la línea de base",
      umbral: `techo ≥ ${TECHO_EXIGIDO} analistas simultáneos`,
      medido: `sin línea de base: ${base.fallaron} de ${base.muestras} fallaron`,
      ok: false,
      filas,
      notas: [AVISO_FUNCION],
    };
  }

  // `MUESTRAS` en todos los niveles, no `nivel * 4`: si el tamaño de muestra
  // cambia con el nivel, el p95 estimado cambia de sesgo justo a lo largo del
  // eje que la rampa compara, y el techo que sale es del estimador.
  for (const nivel of NIVELES_ESTRES.filter((n) => n <= max)) {
    const f = fila(`${nivel} simultáneos`, await measure(MUESTRAS, nivel, escenario.run));
    filas.push(f);
    console.log(
      `  ${String(nivel).padStart(3)} simultáneos   p95 ${ms(f.p95).padStart(7)}   fallaron ${f.fallaron}`
    );

    if (f.fallaron > 0) {
      rompio = `${f.fallaron} consulta(s) fallada(s) a ${nivel} simultáneos`;
      break;
    }
    if (f.p95 > base.p95 * ROMPE_SI_TARDA) {
      rompio = `el p95 se fue a ${veces(base.p95, f.p95).toFixed(1)}× la base a ${nivel} simultáneos`;
      break;
    }
    techo = nivel;
  }

  const s = await sonda();
  if (s) filas.push(fila("sonda /api/health, después", [s]));

  const ok = techo >= TECHO_EXIGIDO;
  console.log(
    `\n  Techo encontrado: ${techo || "ninguno"} analistas simultáneos sin degradarse.` +
      (rompio ? `\n  Rompió porque ${rompio}.` : `\n  No rompió: el techo está más arriba de ${max}.`)
  );

  const notas = [AVISO_FUNCION];
  if (sondaNota) notas.push(sondaNota);

  return {
    nombre: "estres",
    pregunta: "¿Dónde está el techo, y qué se rompe primero al llegar?",
    metrica: "la concurrencia más alta que todavía responde como la línea de base",
    umbral: `techo ≥ ${TECHO_EXIGIDO} analistas simultáneos`,
    medido: `techo ${techo} · ${rompio ?? `sin romper hasta ${max}`}`,
    ok,
    filas,
    notas,
  };
}

/** Las filas de un EXPLAIN, venga el driver con `{rows}` o con un arreglo. */
function lineasDelPlan(resultado: unknown): string {
  const filas = Array.isArray(resultado)
    ? resultado
    : ((resultado as { rows?: unknown[] } | null)?.rows ?? []);
  return filas.map((r) => Object.values(r as Record<string, unknown>)[0]).join(" ");
}

/**
 * Preguntarle a Postgres cómo piensa resolver las consultas del tablero.
 *
 * Una latencia medida con pocos casos no dice nada sobre el futuro: una
 * consulta que recorre la tabla entera es rapidísima con doscientas filas y
 * está condenada con doscientas mil. El plan lo dice hoy, con las filas que
 * haya.
 *
 * Explica LAS CONSULTAS QUE CORREN, armadas con los mismos armadores que usa
 * `listCases`, y las corre por la capa de datos: rol `claimmix_app`, sin
 * BYPASSRLS, con el filtro por inquilino puesto por la política y con el
 * contexto adelante en el mismo lote. Antes explicaba un `select id from cases
 * where tenant_id = '…'` escrito a mano y ejecutado con el rol dueño: otro rol,
 * otro predicado y otra forma. Se podía cambiar el orden, el filtro o los
 * índices del listado y este chequeo seguía verde, que es la única razón por la
 * que el trabajo «Carga (lectura)» existe en el post-deploy.
 */
async function explainPlans(): Promise<{ ok: boolean; notas: string[] }> {
  console.log("\nCómo las resuelve Postgres:\n");

  const notas: string[] = [];
  let ok = true;

  const plans = [
    {
      name: "listado",
      // La pantalla que abre todo el mundo, todo el tiempo. Si esta empieza a
      // recorrer la tabla entera es una regresión, no una decisión: quiere
      // decir que alguien tocó el orden o el filtro y dejó el índice afuera.
      exigeIndice: true,
      consulta: (d: ClienteDatos) => consultaListado(d, { ...QUERY } as never),
    },
    {
      // El `count(*)` que viaja con el listado, sin LIMIT. Es el que crece
      // linealmente: el listado con LIMIT 25 no.
      name: "conteo del listado",
      exigeIndice: false,
      consulta: (d: ClienteDatos) => consultaConteo(d, { ...QUERY } as never),
    },
    {
      // La otra mitad de lo que abre la bandeja, y tampoco lleva LIMIT.
      name: "contadores de la bandeja",
      exigeIndice: false,
      consulta: (d: ClienteDatos) => consultaPorEstado(d),
    },
    {
      name: "búsqueda",
      // Ésta SÍ recorre la tabla entera hoy, y está bien que lo haga.
      //
      // Existen los índices de trigramas (migración 0020), pero con 460 casos
      // recorrer la tabla es genuinamente más barato que ir al índice y volver,
      // y el planificador lo sabe. Medido en el ensayo, el cambio ocurre solo:
      //
      //        460 casos    Seq Scan       0,2 ms
      //    200.000 casos    Bitmap Index   5 ms   (sin índice: 97 ms)
      //
      // Por eso `exigeIndice` es false: exigir el índice acá haría fallar el
      // chequeo por una decisión correcta del planificador. Lo que hay que
      // vigilar es que el índice EXISTA — si alguien lo borra, a los cien mil
      // casos la búsqueda se cae sola y nadie va a saber por qué.
      exigeIndice: false,
      consulta: (d: ClienteDatos) => consultaListado(d, { ...QUERY, q: "gonzalez" } as never),
    },
  ];

  for (const plan of plans) {
    try {
      const [resultado] = await enTenantVarias<[unknown]>(CTX, (d) => [
        d.execute(sql`explain ${plan.consulta(d).getSQL()}`),
      ]);
      const explained = lineasDelPlan(resultado);
      // «Seq Scan on cases» y no «Seq Scan» a secas: el plan del listado trae
      // tres subconsultas correlacionadas, y un recorrido barato sobre una
      // tabla chica adentro de una de ellas no es la regresión que se busca.
      // La que se busca es el listado recorriendo `cases` entera.
      const seq = /Seq Scan on (?:public\.)?cases\b/i.test(explained);
      const idx = explained.match(/Index (?:Only )?Scan(?: Backward)? using (\w+)/i);
      if (seq && plan.exigeIndice) ok = false;
      const linea =
        `${plan.name}: ` +
        `${seq ? "recorre `cases` entera (Seq Scan)" : idx ? `usa ${idx[1]}` : "plan mixto"}` +
        `${seq && plan.exigeIndice ? "   ← regresión" : ""}`;
      notas.push(linea);
      console.log(`  ${linea}`);
    } catch (err) {
      /*
       * Si no se pudo explicar, no se comprobó. Antes esto dejaba una nota y
       * seguía con `ok` en true: cualquier motivo —permisos del rol, un cambio
       * de forma del retorno, un hipo de Neon— apagaba en silencio el único
       * chequeo por el que este trabajo existe, y la nota quedaba enterrada en
       * el log de un job verde que nadie abre.
       */
      ok = false;
      const linea = `${plan.name}: NO SE PUDO EXPLICAR (${err instanceof Error ? err.name : "error"}) — el chequeo de índice no corrió`;
      notas.push(linea);
      console.log(`  ✗ ${linea}`);
    }
  }

  /*
   * Que los índices que estas consultas van a necesitar sigan existiendo.
   *
   * Los de trigramas el plan de hoy no los usa —con 460 casos el Seq Scan
   * gana— así que su ausencia no se nota en ninguna medición. Se notaría a los
   * cien mil, de golpe, y el síntoma sería "el tablero se puso lento" sin nada
   * en el diff que lo explique: el índice se habría ido meses antes.
   *
   * Los otros dos son los de las subconsultas correlacionadas del listado, que
   * corren UNA VEZ POR FILA: sin ellos, abrir la bandeja recorre
   * `extracted_fields` y `outbound_messages` veinticinco veces cada una.
   *
   * Por eso se comprueba la existencia y no el uso.
   */
  const declarados = [
    "idx_cases_policyholder_name_trgm",
    "idx_cases_policy_number_trgm",
    "idx_cases_tenant_created",
    "idx_extracted_fields_case_id",
    "idx_outbound_messages_case_id",
  ];
  // sin-inquilino: el catálogo de Postgres no tiene tenant_id.
  const r = await db.execute(
    sql.raw(
      `select indexname from pg_indexes where indexname in (${declarados
        .map((n) => `'${n}'`)
        .join(", ")})`
    )
  );
  const hay = new Set(
    ((r as unknown as { rows: { indexname: string }[] }).rows ?? []).map((x) => x.indexname)
  );
  const faltan = declarados.filter((n) => !hay.has(n));
  console.log("");
  if (faltan.length === 0) {
    const linea = `los ${declarados.length} índices que el tablero necesita están`;
    notas.push(linea);
    console.log(`  ✓ ${linea}`);
  } else {
    ok = false;
    const linea = `faltan ${faltan.length} índice(s): ${faltan.join(", ")}`;
    notas.push(linea);
    console.log(`  ✗ ${linea}`);
    console.log(`     Hoy anda igual y se cae solo cuando la tabla crezca.`);
    console.log(`     Los de búsqueda se reponen con la migración 0020; el resto con la 0001.`);
  }

  return { ok, notas };
}

// ── El camino de escritura: el pico de la puerta de entrada ──────────────────

const RUN = Date.now().toString().slice(-6);

/**
 * Identidades inventadas, dentro del bloque 5490000 que el ensayo ya barre.
 *
 * Si esta corrida se muere a la mitad, el próximo `pnpm check` limpia lo que
 * quedó. Un número de esos no lo puede tener ningún asegurado real, así que la
 * limpieza no puede alcanzar un caso de verdad.
 */
function phoneFor(i: number): string {
  return `5490000${RUN}${String(i).padStart(2, "0")}`;
}

/**
 * Lo que dice cada asegurado. Variado a propósito: el mismo texto treinta veces
 * mide el caché del modelo, no la carga.
 */
const MENSAJES = [
  "Hola, choqué esta mañana en Av. Rivadavia y San Pedrito, mi póliza es la 998877",
  "Buenas, el granizo de anoche me destrozó el techo del auto. Póliza 445566, Marcelo Paz",
  "Se me metieron a robar el estéreo del auto, estaba estacionado en la puerta de casa",
  "Tuve un accidente ayer a la tarde, el otro auto se cruzó de carril. No hubo heridos",
  "Hola quería denunciar un siniestro, me chocaron de atrás en un semáforo",
  "Buenos días, se prendió fuego el motor del auto en la ruta 8, pude bajarme a tiempo",
];

interface Claimant {
  phone: string;
  caseId: string | null;
  /** Cuándo salió SU pedido, no cuándo salió la ráfaga. */
  salio: number;
  ackMs: number;
  ackStatus: number | string;
  repliedMs: number | null;
}

/**
 * Los dos relojes, en el mismo instante.
 *
 * La respuesta al asegurado se fecha en la base (`outbound_messages.created_at`)
 * y el pedido se cronometra acá. Restar uno del otro a secas mezcla dos relojes;
 * con este par tomado a la vez, cada latencia es una diferencia dentro de su
 * propio reloj y el desfasaje entre máquinas se cancela.
 */
async function relojes(): Promise<{ base: number; local: number }> {
  // sin-inquilino: es la hora del servidor, no una fila de nadie.
  const r = await db.execute(sql`select now() as ahora`);
  const filas = (r as unknown as { rows?: Array<{ ahora: string }> }).rows ?? [];
  return { base: new Date(String(filas[0]?.ahora)).getTime(), local: performance.now() };
}

async function loadWrite(escenario: Escenario): Promise<Forma | null> {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("\nFalta WHATSAPP_WEBHOOK_SECRET en .env.local: no puedo entrar por el webhook.");
    return null;
  }

  console.log("\n" + "─".repeat(68));
  console.log(`ESCRITURA — ${claimants} asegurados a la vez contra ${BASE}`);
  console.log("Cada uno es una llamada real al modelo. Nada le llega a una persona.\n");

  // La línea de base del tablero ANTES de la tormenta. Sin ella, «el tablero
  // durante» es un número suelto: no se sabe contra qué era mejor o peor.
  const tableroAntes = fila("tablero antes", await measure(MUESTRAS, 1, escenario.run));

  const reloj = await relojes();
  const started = performance.now();
  const people: Claimant[] = [];

  /**
   * Todos al mismo tiempo, sin escalonar.
   *
   * Escalonar la salida es lo que convierte una prueba de carga en una prueba
   * que siempre pasa. La tormenta no llega escalonada.
   */
  await Promise.all(
    Array.from({ length: claimants }, async (_, i) => {
      const phone = phoneFor(i);
      const t0 = performance.now();
      const person: Claimant = {
        phone,
        caseId: null,
        salio: t0,
        ackMs: 0,
        ackStatus: 0,
        repliedMs: null,
      };
      try {
        const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: phone,
            body: MENSAJES[i % MENSAJES.length],
            provider_message_id: `carga.${RUN}.${i}`,
          }),
        });
        person.ackMs = performance.now() - t0;
        person.ackStatus = res.status;
        const body = (await res.json().catch(() => ({}))) as { case_id?: string };
        person.caseId = body.case_id ?? null;
      } catch (err) {
        person.ackMs = performance.now() - t0;
        person.ackStatus = err instanceof Error ? err.name : "error de red";
      }
      people.push(person);
    })
  );

  const acuse = fila(
    "acuse del webhook",
    people.map((p) => ({ ms: p.ackMs, ok: p.ackStatus === 202 }))
  );

  console.log("Acuse del webhook (lo que espera Meta):");
  console.log(
    `  p50 ${ms(acuse.p50)}   p95 ${ms(acuse.p95)}   máx ${ms(acuse.max)}   fallaron ${acuse.fallaron}`
  );
  if (acuse.fallaron > 0) {
    const codes = new Map<string | number, number>();
    for (const p of people) {
      if (p.ackStatus !== 202) codes.set(p.ackStatus, (codes.get(p.ackStatus) ?? 0) + 1);
    }
    for (const [code, n] of codes) console.log(`    ${n} × ${code}`);
  }
  if (acuse.p95 > P95_ACUSE_MS) {
    console.log(
      `  ✗ por encima de ${ms(P95_ACUSE_MS)}: a este ritmo Meta reintenta y el asegurado`
    );
    console.log(`     recibe cada respuesta dos veces.`);
  }

  // ── Esperar las respuestas ─────────────────────────────────────────────────

  const withCase = people.filter((p) => p.caseId);
  const ids = withCase.map((p) => p.caseId!);
  if (ids.length === 0) {
    console.log("\nNingún caso llegó a crearse. No hay nada que esperar.");
    return {
      nombre: "escritura (pico del camino de entrada)",
      pregunta: "¿El webhook le contesta a Meta a tiempo cuando entran N asegurados juntos?",
      metrica: "p95 del acuse y cuántas denuncias quedan sin respuesta",
      umbral: `acuse p95 < ${ms(P95_ACUSE_MS)} y ninguna sin respuesta`,
      medido: "ningún caso llegó a crearse",
      ok: false,
      filas: [tableroAntes, acuse],
      notas: [],
    };
  }

  console.log(`\nEsperando que el agente conteste a ${ids.length}…`);

  const DEADLINE_MS = 300_000;
  const pending = new Map(withCase.map((p) => [p.caseId!, p]));

  /**
   * El tablero, mientras la tormenta pasa.
   *
   * Es la pregunta que ninguna de las dos fases mide por separado: el analista
   * no trabaja en un sistema en reposo, trabaja en éste, con cien extracciones
   * corriendo por detrás. Si su pantalla se cuelga justo cuando entran cien
   * denuncias, se cuelga exactamente el día que la necesita.
   */
  const duringStorm: Sample[] = [];

  while (pending.size > 0 && performance.now() - started < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 3_000));

    const t0 = performance.now();
    try {
      await listCases(CTX, { ...QUERY } as never);
      duringStorm.push({ ms: performance.now() - t0, ok: true, t: t0 });
    } catch {
      duringStorm.push({ ms: performance.now() - t0, ok: false, t: t0 });
    }

    /*
     * Qué cuenta como «el asegurado recibió una respuesta».
     *
     * Cualquier fila de `outbound_messages` NO cuenta, y así estaba: el paso 5
     * del worker (src/server/worker/extract.ts) inserta un stub con
     * channel='email_sim', template='request_missing_docs' y status='queued'
     * durante la EXTRACCIÓN, mucho antes de que el mensajero redacte nada —
     * y con estos seis mensajes, que son todos primeros contactos incompletos,
     * lo escribe prácticamente siempre. El cronómetro paraba en «el worker
     * decidió que faltan papeles» y eso se publicaba como percepción del
     * asegurado. Peor: `sin respuesta` no podía dar más de cero aunque el
     * mensajero fallara entero, así que el umbral «ninguna sin respuesta»
     * salía verde con el camino de salida roto.
     *
     * El producto define esto en dos lugares y los dos son más estrictos:
     * list.ts exige status='sent', y el orquestador ['sent','skipped_simulated'].
     * Se usa el segundo porque el camino Bearer marca el caso como simulado y
     * el mensajero registra 'skipped_simulated' en vez de llamar a Graph.
     * 'failed' y 'queued' quedan afuera: no son una respuesta.
     */
    const replied = await db
      .select({
        caseId: outboundMessages.case_id,
        cuando: sql<string>`min(${outboundMessages.created_at})`,
      })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.tenant_id, TENANT_ID!),
          inArray(outboundMessages.case_id, ids),
          inArray(outboundMessages.status, ["sent", "skipped_simulated"])
        )
      )
      .groupBy(outboundMessages.case_id);

    for (const row of replied) {
      const person = row.caseId ? pending.get(row.caseId) : undefined;
      if (!person) continue;
      /*
       * La latencia se fecha en la base, no en la vuelta del sondeo.
       *
       * Antes era `performance.now() - started`, calculada UNA VEZ por vuelta y
       * puesta igual a todos los que aparecían en esa vuelta: un piso de 3 s
       * aunque el agente contestara en 400 ms, resolución de 3 s, todos los de
       * una misma vuelta con el mismo valor, y `started` tomado antes de toda
       * la ráfaga — o sea que a cada asegurado se le cargaba la cola de los
       * otros veintinueve. Un p95 sobre eso no estima ninguna cola: dice cuál
       * fue la última vuelta con alguien pendiente.
       */
      const escrita = new Date(row.cuando).getTime();
      person.repliedMs = Math.max(0, escrita - reloj.base - (person.salio - reloj.local));
      pending.delete(row.caseId!);
    }
    process.stdout.write(`\r  ${ids.length - pending.size}/${ids.length} contestados…    `);
  }
  const tormentaMs = performance.now() - started;
  console.log("");

  const respuesta = fila(
    "hasta la respuesta al asegurado",
    withCase.map((p) => ({ ms: p.repliedMs ?? DEADLINE_MS, ok: p.repliedMs !== null }))
  );

  console.log("\nHasta que el asegurado recibe una respuesta:");
  console.log(
    `  p50 ${ms(respuesta.p50)}   p95 ${ms(respuesta.p95)}   máx ${ms(respuesta.max)}   sin respuesta ${respuesta.fallaron}`
  );

  const tableroDurante = fila("tablero durante", duringStorm);
  console.log("\nEl tablero del analista, durante todo esto:");
  console.log(
    `  p50 ${ms(tableroDurante.p50)}   p95 ${ms(tableroDurante.p95)}   máx ${ms(tableroDurante.max)}` +
      `   fallaron ${tableroDurante.fallaron}   ${tableroDurante.muestras} muestras`
  );

  // Y después: que la tormenta no deje al tablero lento cuando ya pasó.
  const tableroDespues = fila("tablero después", await measure(MUESTRAS, 1, escenario.run));
  const recuperacion = veces(tableroAntes.p95, tableroDespues.p95);
  console.log(
    `\nEl tablero, ya pasada la tormenta: p95 ${ms(tableroDespues.p95)} (${razon(recuperacion)} el de antes).`
  );

  const estados = await db
    .select({ status: cases.status, n: count() })
    .from(cases)
    .where(inArray(cases.id, ids))
    .groupBy(cases.status);

  console.log("\nEstado final de los casos:");
  for (const row of estados) console.log(`  ${row.n} × ${row.status}`);

  /*
   * Atendidas, y en el tiempo de la tormenta.
   *
   * El numerador era `claimants`, el número PEDIDO: con cinco 500 y cuatro sin
   * contestar seguía imprimiendo «30 denuncias atendidas», y con el plazo
   * agotado a la mitad decía «30 en 300s», que es sencillamente falso. El
   * denominador se tomaba DESPUÉS de medir el tablero de después, así que se
   * le sumaban veinte consultas y un viaje a la base que no tienen nada que
   * ver. Es la línea que un lector se lleva de la corrida cara.
   */
  const contestadas = withCase.length - pending.size;
  const elapsed = tormentaMs / 1000;
  console.log(
    `\n${contestadas} de ${claimants} denuncias contestadas en ${elapsed.toFixed(0)}s ` +
      `· ${((contestadas / elapsed) * 60).toFixed(0)} por minuto.`
  );

  const ok =
    acuse.fallaron === 0 &&
    respuesta.fallaron === 0 &&
    acuse.p95 <= P95_ACUSE_MS &&
    tableroAntes.fallaron === 0 &&
    // El tablero durante la tormenta se medía, se imprimía y se publicaba como
    // umbral, y no entraba en el veredicto: la pantalla podía fallar las veinte
    // vueltas del sondeo —el escenario exacto que esta fase dice cazar— y la
    // forma salía ✓.
    tableroDurante.fallaron === 0 &&
    tableroDespues.fallaron === 0 &&
    recuperacion <= EMPEORA_MAX;

  return {
    nombre: "escritura (pico del camino de entrada)",
    pregunta:
      "¿El webhook le contesta a Meta a tiempo cuando entran N asegurados juntos, y el tablero se recupera después?",
    metrica: "p95 del acuse, denuncias sin respuesta, y el tablero antes / durante / después",
    umbral: `acuse p95 < ${ms(P95_ACUSE_MS)}, ninguna sin respuesta, tablero sin fallas y ≤ ${EMPEORA_MAX}× el de antes`,
    medido: `acuse p95 ${ms(acuse.p95)} · ${respuesta.fallaron} sin respuesta · tablero ${razon(recuperacion)}`,
    ok,
    filas: [tableroAntes, acuse, respuesta, tableroDurante, tableroDespues],
    notas: [
      `${claimants} asegurados simultáneos contra ${BASE}. Gasta del mismo cupo del modelo que atiende asegurados reales.`,
      "«Hasta la respuesta» termina cuando la respuesta queda registrada, con el caso " +
        "marcado como simulado: no incluye la llamada a Graph, que es el último tramo y " +
        "el que más se degrada con volumen.",
      "Mide el canal de WhatsApp. El de mail hace cola aparte —extract.ts serializa las " +
        "extracciones de mail en GEMINI_WORKER_CONCURRENCY, por omisión una a la vez— así " +
        "que estas denuncias por minuto no son la capacidad del sistema por mail.",
      "El tablero durante la tormenta es una muestra por vuelta del sondeo (una cada 3 s): " +
        "con pocas vueltas, su p95 no es una distribución. Mirá la columna de muestras.",
    ],
  };
}

/**
 * Borrar todo lo que esta corrida creó.
 *
 * Corre también con Ctrl-C: una prueba de carga interrumpida deja treinta casos
 * con nombres inventados en la bandeja del analista, que es exactamente el
 * problema que el barrido del ensayo existe para arreglar y que conviene no
 * crear en primer lugar.
 */
async function cleanup(): Promise<void> {
  const mine = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.tenant_id, TENANT_ID!), like(cases.email_thread_id, `5490000${RUN}%`)));

  if (mine.length === 0) return;

  const { deleteAttachment } = await import("@/server/storage/claim-attachments-bucket");
  for (const row of mine) {
    const files = await db
      .select({ path: claimAttachments.storage_path })
      .from(claimAttachments)
      .where(eq(claimAttachments.case_id, row.id));
    for (const file of files) if (file.path) await deleteAttachment(file.path);
    await db.delete(cases).where(eq(cases.id, row.id));
  }
  console.log(`\nBorrados ${mine.length} caso(s) de la prueba.`);
}

/**
 * No medir el mock.
 *
 * Contra el extractor simulado esto reporta latencias preciosas de un sistema
 * que no llamó a ningún modelo: el número más engañoso posible, porque dice
 * que aguanta diez veces más de lo que aguanta.
 */
async function refuseIfMocked(): Promise<void> {
  const { resolveExtractionEngine } = await import("@/server/ai/provider");
  if ((await resolveExtractionEngine(TENANT_ID!)) === "mock") {
    console.error(
      "El motor de extracción resolvió a 'mock'. Las latencias serían de un\n" +
        "sistema que no llama a ningún modelo — diez veces mejores que las reales."
    );
    process.exit(1);
  }

  /*
   * Y tampoco medir un sistema sin presupuesto.
   *
   * Cien denuncias contra un cupo agotado se contestan todas en cero segundos,
   * porque el worker ni llama al modelo. El número sale precioso y es mentira.
   *
   * Vale saber además que esta prueba GASTA de ese cupo: cien denuncias son
   * más o menos un millón y medio de tokens del mismo tenant que atiende a los
   * asegurados de verdad.
   */
  const { checkBudget } = await import("@/server/ai/budget");
  const budget = await checkBudget(TENANT_ID!);
  if (budget.exceeded) {
    console.error(`No hay presupuesto para medir nada: ${budget.reason}`);
    process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log("\nInterrumpido. Limpiando…");
  void cleanup().finally(() => process.exit(130));
});

const endpoints = verificarEndpoints();
const inventadas = endpoints.filter((e) => !e.existe);
if (inventadas.length > 0) {
  console.error(
    `La prueba nombra rutas que ya no están en src/app/api: ${inventadas
      .map((e) => e.ruta)
      .join(", ")}\n` +
      "Alguien las renombró o las borró. Arreglá la lista antes de medir: un 404\n" +
      "acá se cuenta como falla de carga y manda a buscar el problema al lado equivocado."
  );
  process.exit(1);
}

const formas: Forma[] = [];
let ok = true;

const { escenarios, casos, notas: notasLectura } = await prepararLectura();
console.log(`Casos que ve el listado: ${casos}\n`);
for (const n of notasLectura) console.log(`  ${n}`);

try {
  // Las tres formas de a una consulta corren sobre el listado y no sobre las
  // tres: es la pantalla que abre todo el mundo, y repetirlas por escenario
  // multiplica el tiempo contra la base de producción sin cambiar la respuesta.
  for (const forma of corren) {
    if (forma === "carga") {
      const f = await formaCarga(escenarios);
      const planes = await explainPlans();
      f.ok = f.ok && planes.ok;
      f.notas.push(...notasLectura, ...planes.notas);
      formas.push(f);
    } else if (forma === "pico") {
      formas.push(await formaPico(escenarios[0]!));
    } else if (forma === "resistencia") {
      formas.push(await formaResistencia(escenarios[0]!, MINUTOS));
    } else {
      formas.push(await formaEstres(escenarios[0]!, NIVELES_ESTRES.at(-1)!));
    }
  }

  if (doWrite) {
    await refuseIfMocked();
    const f = await loadWrite(escenarios[0]!);
    if (f) formas.push(f);
    else ok = false;
  } else {
    console.log(
      "\nSin --write no se prueba el camino de entrada, que es donde está el\n" +
        "modelo y donde está el límite de verdad."
    );
  }
} finally {
  if (doWrite) await cleanup();
}

ok = ok && formas.every((f) => f.ok);

console.log("\n" + "─".repeat(68));
for (const f of formas) {
  console.log(`${f.ok ? "✓" : "✗"} ${f.nombre.padEnd(34)} ${f.medido}`);
}

if (reporte) {
  const escritos = escribirReporte(reporte, {
    cuando: new Date().toISOString(),
    base: BASE,
    casos,
    ok,
    endpoints,
    formas,
  });
  console.log(`\n(resultados en ${escritos.join(" y ")})`);
}

console.log("");
// exitCode, no exit(): llamar a process.exit() con sockets todavía cerrándose
// revienta Node en Windows con una aserción de libuv.
process.exitCode = ok ? 0 : 1;
