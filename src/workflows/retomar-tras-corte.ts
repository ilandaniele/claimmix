/**
 * La retoma de un caso que el worker difirió por una falla pasajera.
 *
 * Un TIMEOUT, un 429 o un corte de red deja el caso marcado `extraction_pending`
 * y con la reserva suelta, pero lo único que lee esa marca es el barrido de
 * `retomarExtraccionesPendientes`: corre cuando entra tráfico de otro caso o en
 * el cron diario. Sin tráfico, el denunciante espera horas una respuesta que
 * ya estaba lista para darse.
 *
 * Este flujo es lo que faltaba: espera 45 s —lo que le damos al proveedor para
 * recuperarse— y retoma ESE caso. No decide nada por su cuenta: pasa por los
 * mismos predicados del barrido (estado, marca, reserva libre o vencida), así
 * que si mientras tanto entró un mensaje o lo levantó otro barrido, no hace nada.
 *
 * Sin bucle y sin reintentos del SDK. Si la retoma vuelve a fallar, el worker
 * mismo arranca otro flujo, y `MAX_REINTENTOS_POR_TIMEOUT` (de por vida) corta
 * la cadena en tres. Reintentar el paso pagaría el modelo otra vez.
 */
import { sleep } from "workflow";
import { FUNCION_MAS_CORTA_MS } from "@/core/case/reserva-de-extraccion";
import { retomarExtraccionesPendientes } from "@/server/intake/retomar-pendientes";

export interface EntradaRetoma {
  readonly caseId: string;
  readonly tenantId: string;
}

const ESPERA_DE_LA_RETOMA = "45s";

/**
 * Retomar el caso.
 *
 * `hasta` sale de la hora de ESTE paso, no del orquestador, y es la función más
 * corta: entra con margen en los 300 s del flujo y no pasa de la reserva, así
 * que no vence con la corrida viva. `limit: 1` y `caseId`: sólo el caso que lo
 * difirió, sin esperar los dos minutos del barrido general.
 */
async function retomarElCaso(entrada: EntradaRetoma): Promise<number> {
  "use step";

  const { retomados } = await retomarExtraccionesPendientes({
    tenantId: entrada.tenantId,
    caseId: entrada.caseId,
    limit: 1,
    hasta: Date.now() + FUNCION_MAS_CORTA_MS,
  });
  return retomados;
}
// Un reintento del SDK llamaría al modelo de nuevo. Si el proceso muere a mitad
// de camino, la cola lo reentrega y encuentra la reserva viva: no hace nada.
retomarElCaso.maxRetries = 0;

/**
 * El orquestador. Esperar y retomar, en ese orden.
 *
 * Sin efectos propios —ni consultas ni leer la hora—: este cuerpo se vuelve a
 * ejecutar desde el principio en cada reanudación.
 */
export async function retomarTrasCorte(entrada: EntradaRetoma): Promise<number> {
  "use workflow";

  await sleep(ESPERA_DE_LA_RETOMA);
  return retomarElCaso(entrada);
}
