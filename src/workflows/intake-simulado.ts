/**
 * La simulación de una carga, como flujo durable.
 *
 * Antes esto era un `after(async () => …)`: la respuesta salía y el trabajo
 * quedaba corriendo en la misma invocación. Funciona hasta que no.
 *
 * Cuando se encolan muchos casos —una simulación por lotes con espera entre
 * uno y otro— el presupuesto de tiempo de la función se agota y Vercel
 * **descarta** los `after()` que todavía no arrancaron. Los casos quedan en
 * `procesando` para siempre: el INSERT ocurrió y el agente nunca corrió. Hay un
 * barrido nocturno escrito sólo para eso (`src/server/intake/reap-stuck.ts`),
 * que es la señal de que el problema es del mecanismo y no del código.
 *
 * Un flujo durable no vive en la invocación que lo arrancó. Cada `"use step"`
 * se encola y corre en su propia petición, y el orquestador queda suspendido
 * mientras tanto sin consumir nada. Si el proceso muere, retoma en el paso que
 * seguía — no repite el anterior.
 *
 * Por qué los pasos están cortados donde están: el límite de un paso es el
 * límite de lo que se repite si algo falla. Esperar el turno es barato y se
 * puede repetir; correr el agente cuesta una llamada al modelo y escribe en la
 * base, así que va solo, y lo que ya se hizo no se vuelve a hacer.
 */
import { runIntakeAgent } from "@/server/agents/intake-agent";
import { waitForSimulationTurn } from "@/server/intake/simulation-throttle";

export interface EntradaSimulacion {
  readonly caseId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly caseCreatedAt: string | null;
}

/**
 * Esperar a que le toque el turno a este caso.
 *
 * Separado del paso siguiente a propósito. Es la parte que puede tardar y la
 * que no cuesta nada repetir: si se cae acá, se vuelve a esperar y no se gastó
 * ni una llamada al modelo.
 */
async function esperarElTurno(entrada: EntradaSimulacion): Promise<void> {
  "use step";

  const turno = await waitForSimulationTurn({
    tenantId: entrada.tenantId,
    caseId: entrada.caseId,
    caseCreatedAt: entrada.caseCreatedAt,
  });

  if (turno.timedOut) {
    // Se sigue igual. La espera es para no atropellar al modelo con veinte
    // casos a la vez, no una condición para procesar: quedarse acá dejaría el
    // caso en `procesando`, que es exactamente lo que esto vino a evitar.
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "intake.simulate.queue_wait_timed_out",
        case_id: entrada.caseId,
        blockers: turno.blockers,
        waited_ms: turno.waitedMs,
      })
    );
  }
}

/**
 * Correr el agente sobre el caso.
 *
 * Es el paso caro: llama al modelo y escribe la extracción. Va solo para que un
 * fallo en cualquier otra parte no lo repita.
 */
async function correrElAgente(entrada: EntradaSimulacion): Promise<void> {
  "use step";

  await runIntakeAgent({
    caseId: entrada.caseId,
    tenantId: entrada.tenantId,
    userId: entrada.userId,
    source: "simulate",
  });
}

/**
 * El orquestador. No hace trabajo: decide el orden.
 *
 * Nada de lo que se escriba acá adentro puede tener efectos —ni consultas, ni
 * llamadas, ni leer la hora—, porque este cuerpo se vuelve a ejecutar desde el
 * principio en cada retoma, reproduciendo los resultados que ya tiene. Los
 * efectos van adentro de los pasos, que se ejecutan una sola vez.
 */
export async function procesarCasoSimulado(entrada: EntradaSimulacion): Promise<void> {
  "use workflow";

  await esperarElTurno(entrada);
  await correrElAgente(entrada);
}
