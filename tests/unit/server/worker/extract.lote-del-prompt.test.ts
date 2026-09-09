/**
 * Todo lo que arma el prompt, en un viaje — y el reserva cuando no se puede.
 *
 * Eran seis llamadas dentro de un `Promise.all`, y siete consultas porque los
 * ejemplos hacen dos. En paralelo, sí, pero no juntas: cada `enTenant` abre su
 * propia transacción HTTP con su `set_config` adelante.
 *
 * Medido contra producción, quince corridas intercaladas: p50 288 ms el lote
 * contra 873 ms de a uno.
 *
 * Lo que hay que cuidar es la degradación. Cada cargador tenía su `try/catch` y
 * su valor por omisión —sin reglas se extrae igual— y en un lote no hay errores
 * parciales: una tabla que falta tumba la transacción entera.
 */

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const TENANT_ID = "bbbbbbbb-0000-4000-8000-000000000022";

afterEach(() => vi.restoreAllMocks());

/**
 * @param loteFalla  Hace que `enTenantVarias` tire, como lo haría una tabla que
 *                   todavía no existe en un entorno.
 */
async function correr(loteFalla: boolean) {
  vi.resetModules();

  const espiaDeUpdate: Mock<(data: Record<string, unknown>) => void> = vi.fn();
  const { mockDb } = registrarMocks({ fila: filaDeCaso(CASE_ID, TENANT_ID), espiaDeUpdate });

  /*
   * `tables` de verdad, sólo acá.
   *
   * El andamiaje compartido lo simula con dos llaves vacías, y eso alcanza
   * mientras cada consulta viva adentro de un cargador con su `catch`: nombrar
   * una tabla que no está tira un TypeError que el `catch` se come y devuelve
   * el valor por omisión. Para mirar el LOTE hace falta que las consultas se
   * puedan armar. El esquema es puro `pgTable`, sin conexión.
   *
   * Va en este archivo y no en el andamiaje porque cambiarlo allá mueve el
   * comportamiento de los otros cinco archivos de test del worker.
   */
  const esquema = await vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
  vi.doMock("@/lib/db", () => ({ db: mockDb, tables: esquema }));

  const lotes: number[] = [];
  const cargasSueltas = vi.fn();

  vi.doMock("@/data/scope", () => ({
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) => {
      cargasSueltas();
      return Promise.resolve(armar(mockDb));
    },
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) => {
      const consultas = armar(mockDb);
      lotes.push(consultas.length);
      if (loteFalla) return Promise.reject(new Error("relation does not exist"));
      return Promise.all(consultas);
    },
  }));

  const espiaError = vi.spyOn(console, "error").mockImplementation(() => {});
  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);
  const errores = espiaError.mock.calls.flat().map(String).join(" ");
  espiaError.mockRestore();

  return { lotes, cargasSueltas, errores };
}

describe("cargarLoDelPrompt", () => {
  it("manda las siete consultas del prompt en un solo lote", async () => {
    const { lotes } = await correr(false);
    // Patrones, entrenamiento, reglas, los DOS de ejemplos, versión y campos.
    expect(lotes).toContain(7);
  });

  it("y si el lote se cae, vuelve por el camino de a uno", async () => {
    // El reserva es la razón por la que esto se puede hacer: sin él, una tabla
    // que falta dejaría de degradar y pasaría a apagar la carga completa.
    const { cargasSueltas, errores } = await correr(true);

    expect(errores).toContain("email_worker.lote_del_prompt_fallo");
    // Seis cargadores, cada uno con su `enTenant` y su valor por omisión.
    expect(cargasSueltas.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("y cuando el lote anda, no carga nada de a uno además", async () => {
    /*
     * El control. Un lote que se agregara a las cargas sueltas en vez de
     * reemplazarlas dejaría los dos tests de arriba en verde y el worker
     * haciendo MÁS viajes que antes, no menos.
     *
     * El worker usa `enTenant` para otras cosas —el caso, el mensaje, el
     * lease—, así que lo que se cuenta es la diferencia: con el lote caído hay
     * seis cargas más que con el lote andando.
     */
    const conLote = await correr(false);
    const sinLote = await correr(true);

    expect(sinLote.cargasSueltas.mock.calls.length).toBeGreaterThan(
      conLote.cargasSueltas.mock.calls.length
    );
  });
});
