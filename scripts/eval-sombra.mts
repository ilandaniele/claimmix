/**
 * ¿Cuánto coincide el modelo con el código? Gravedad, derivar y pedir, escenario por escenario.
 *
 * Es la medida del modo sombra sin pasar por el ensayo de conversaciones: corre
 * la extracción de cada escenario sintético de `src/server/intake/scenarios.ts`,
 * calcula con la misma regla que el worker lo que decide el código, y compara.
 * Mide coincidencia, no acierto: que el modelo y el código digan lo mismo no
 * prueba que los dos tengan razón. `responder` no se mide acá, sale del ensayo.
 *
 * Con `agentTraining` armado con las secciones de sombra de la base
 * (`textoDeSombra`), o sin él con `--sin-sombra`, que es la línea de base. Para
 * comparar las dos hay que correr el script dos veces: cada corrida hace UNA
 * extracción por escenario.
 *
 * El gasto es real y no se ve en ningún lado. No pasa tenantId, así que no
 * escribe en ninguna base ni en el presupuesto del inquilino, y por eso tampoco
 * aparece en el tope ni en /metricas. Con `--todos` son unas 163 extracciones
 * con gemini-3.8-flash, el doble si se corre también `--sin-sombra`. Los
 * escenarios con fotos o audio se evalúan sin ellos, así que la extracción
 * difiere de la del ensayo.
 *
 * Sólo escenarios sintéticos: no lee las corridas reales del agente ni importa
 * la capa de base.
 *
 * Uso:  pnpm sombra:evaluar [--seco] [--todos | --escenarios a,b] [--limite N] [--sin-sombra] [--reporte ruta.json]
 *
 *   --escenarios a,b   los ids, separados por coma
 *   --limite N         tope de escenarios; 10 por omisión, repartidos parejo por la lista.
 *                      Con --todos o --escenarios sólo recorta si se pasa a propósito
 *   --todos            todos los escenarios (imprime cuántos son)
 *   --sin-sombra       línea de base: la extracción sin agentTraining
 *   --reporte ruta     JSON con ids, claves, enums, conteo, versión de la base y modelo. Sin texto
 *   --seco             imprime la selección y cuántas llamadas haría, y sale sin llamar
 *
 * Sale con 0 salvo error técnico (argumentos inválidos o una extracción que falló).
 */
import * as dotenv from "dotenv";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { textoDeSombra, VERSION_DEL_ENTRENAMIENTO_BASE } from "@/core/agente/entrenamiento-base";
import {
  conteoVacio,
  lineaDeSombra,
  normalizarFaltantes,
  resumenDeSombra,
  sombraDeLaExtraccion,
  sumarSombra,
  type SombraDeLaVuelta,
} from "@/core/agente/sombra";
import { claveDelRamoDelCaso, faltantesRequeridos, mapaDeCampos } from "@/core/case/faltantes-requeridos";
import { hayHeridos } from "@/core/case/heridos-supuestos";
import { camposRequeridosDelRamo } from "@/core/case/required-fields";
import { errorCode } from "@/lib/observability/error-code";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import { classifySeverity, requiresSpecialist } from "@/server/ai/severity-classifier";
import { remitenteDeEnsayo } from "@/server/intake/remitente-de-ensayo";
import { SCENARIOS, type SimulationScenario } from "@/server/intake/scenarios";

const LIMITE_POR_OMISION = 10;
const DECISIONES_EVALUADAS = ["gravedad", "derivar", "pedir"] as const;

function usoInvalido(mensaje: string): never {
  console.error(mensaje);
  process.exit(2);
}

function leerOpciones() {
  try {
    return parseArgs({
      options: {
        escenarios: { type: "string" },
        limite: { type: "string" },
        todos: { type: "boolean", default: false },
        reporte: { type: "string" },
        "sin-sombra": { type: "boolean", default: false },
        seco: { type: "boolean", default: false },
      },
    }).values;
  } catch (e) {
    return usoInvalido(e instanceof Error ? e.message : "Argumentos inválidos");
  }
}

const opciones = leerOpciones();

const sinSombra = opciones["sin-sombra"];
const seco = opciones.seco;

if (opciones.todos && opciones.escenarios !== undefined) {
  usoInvalido("--todos y --escenarios no van juntos.");
}

let limite: number | null = null;
if (opciones.limite !== undefined) {
  limite = Number(opciones.limite);
  if (!Number.isInteger(limite) || limite < 1) usoInvalido("--limite tiene que ser un entero desde 1.");
}

/** `n` elementos repartidos parejo por la lista: determinista, y cubre los ramos en vez de los diez primeros. */
function repartidos<T>(lista: readonly T[], n: number): T[] {
  if (n >= lista.length) return [...lista];
  return Array.from({ length: n }, (_, i) => lista[Math.floor((i * lista.length) / n)]!);
}

function elegir(): SimulationScenario[] {
  if (opciones.escenarios !== undefined) {
    const ids = opciones.escenarios.split(",").map((id) => id.trim()).filter(Boolean);
    const encontrados = ids.map((id) => SCENARIOS.find((s) => s.id === id));
    const desconocidos = ids.filter((_, i) => !encontrados[i]);
    if (ids.length === 0 || desconocidos.length > 0) {
      usoInvalido(`No hay escenario con ese nombre: ${desconocidos.join(", ") || "(ninguno)"}.`);
    }
    return encontrados.slice(0, limite ?? ids.length) as SimulationScenario[];
  }
  if (opciones.todos) return limite === null ? [...SCENARIOS] : repartidos(SCENARIOS, limite);
  return repartidos(SCENARIOS, limite ?? LIMITE_POR_OMISION);
}

/**
 * Lo que dice el modelo frente a lo que decide el código, con la misma regla del worker.
 *
 * Sin historial no hay `sinHeridosSupuestos` ni `gravedadSinHechosNuevos`: es el primer
 * mensaje del caso, así que el modelo se compara tal cual salió.
 */
function sombraDelEscenario(texto: string, claim: ExtractedClaim): SombraDeLaVuelta {
  const g = classifySeverity(texto, claim.severity, []);
  const herido = hayHeridos(claim);
  const s = sombraDeLaExtraccion(claim, {
    gravedad: g,
    deriva: requiresSpecialist(g) || herido,
    piso: herido || g === "critical",
  });
  const m = mapaDeCampos(claim.fields ?? []);
  s.pedir = {
    agente: normalizarFaltantes(claim.missing_fields ?? []),
    codigo: normalizarFaltantes(
      faltantesRequeridos(m, camposRequeridosDelRamo(claveDelRamoDelCaso(m)), [])
    ),
    descartadas: 0,
  };
  return s;
}

type Resultado =
  | { id: string; sombra: SombraDeLaVuelta }
  | { id: string; motivo: "no_es_denuncia" }
  | { id: string; error: string };

async function evaluar(escenarios: readonly SimulationScenario[]): Promise<void> {
  console.log(
    "Se gastan tokens de verdad y el gasto no entra al tope ni a /metricas: la corrida no lleva inquilino.\n"
  );

  // El entorno se carga acá y no al arrancar: --seco no lee .env.local. Y antes del import, que lo lee al cargar.
  dotenv.config({ path: ".env.local" });
  const { extractEmailClaimGemini } = await import("@/server/ai/gemini-extractor");
  const agentTraining = sinSombra ? undefined : textoDeSombra(DECISIONES_EVALUADAS);

  let conteo = conteoVacio();
  let modelo: string | null = null;
  const resultados: Resultado[] = [];

  for (const e of escenarios) {
    const subject = `[email_sim] Siniestro - ${e.id}`;
    try {
      const claim = await extractEmailClaimGemini(
        {
          subject,
          body: e.raw_text,
          senderEmail: remitenteDeEnsayo(e.policyholder_name),
          channel: "email_sim",
          memoryHints: [],
          knownPatterns: [],
          agentTraining,
        },
        undefined,
        "eval-sombra"
      );
      modelo ??= claim.extraction_model;

      // Lo mismo que el worker: sin denuncia no hay sombra que anotar.
      if (claim.is_claim === false || claim.parse_failed === true) {
        console.log(`${e.id}  sin sombra (no es denuncia)`);
        resultados.push({ id: e.id, motivo: "no_es_denuncia" });
        continue;
      }

      const sombra = sombraDelEscenario(`${subject}\n\n${e.raw_text}`, claim);
      conteo = sumarSombra(conteo, sombra);
      console.log(`${e.id}  ${lineaDeSombra(sombra)}`);
      resultados.push({ id: e.id, sombra });
    } catch (err) {
      const codigo = errorCode(err);
      console.log(`${e.id}  error técnico: ${codigo}`);
      resultados.push({ id: e.id, error: codigo });
    }
  }

  const fallas = resultados.filter((r) => "error" in r).length;
  console.log(`\n${resumenDeSombra(conteo)}`);
  if (fallas > 0) console.log(`Errores técnicos: ${fallas} de ${escenarios.length}.`);

  if (opciones.reporte) {
    writeFileSync(
      opciones.reporte,
      JSON.stringify(
        {
          version: VERSION_DEL_ENTRENAMIENTO_BASE,
          modelo,
          sinSombra,
          llamadas: escenarios.length,
          escenarios: resultados,
          conteo,
        },
        null,
        2
      )
    );
    console.log(`(reporte escrito en ${opciones.reporte})`);
  }

  process.exitCode = fallas > 0 ? 1 : 0;
}

const elegidos = elegir();

console.log(
  `Escenarios: ${elegidos.length} de ${SCENARIOS.length}. ` +
    `Modo: ${sinSombra ? "sin sombra (línea de base)" : "con sombra"}.\n` +
    `Llamadas a la extracción: ${elegidos.length}, una por escenario. ` +
    `Si el JSON viene inválido, la extracción reintenta una vez sola.\n`
);

if (seco) {
  for (const s of elegidos) console.log(`${s.id}  ${s.case_type}`);
  console.log("\nSeco: no se llamó a ningún servicio.");
} else {
  await evaluar(elegidos);
}
