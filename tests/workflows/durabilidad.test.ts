/**
 * ¿La durabilidad es real, o las directivas son decoración?
 *
 * Este es el test que decide si valió la pena traer el SDK. Sin el compilador
 * de flujos, `"use workflow"` y `"use step"` son literales de cadena que no
 * hacen nada: la función corre de arriba abajo como cualquier otra, todo
 * "funciona", y no hay durabilidad por ningún lado. Eso pasaría inadvertido en
 * cualquier test que sólo mire el valor devuelto.
 *
 * Por eso lo que se mide acá no es el resultado sino CUÁNTAS VECES corrió cada
 * paso. Un paso que falla y se reintenta tiene que reintentarse él solo; los
 * anteriores ya están hechos y no se vuelven a hacer.
 *
 * En este producto eso no es una sutileza de arquitectura. El paso caro llama
 * al modelo y le manda un mail a un damnificado. Repetirlo son dos mails.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { start } from "workflow/api";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tresPasos } from "@/workflows/_prueba-durabilidad";
import { leerBitacora, borrarBitacora } from "@/workflows/_prueba-bitacora";

// Un archivo por corrida, para que dos tests no se pisen.
let archivo = "";
const usados: string[] = [];

beforeEach(() => {
  archivo = join(tmpdir(), `claimmix-durabilidad-${usados.length}.log`);
  usados.push(archivo);
  borrarBitacora(archivo);
});

afterAll(() => {
  for (const a of usados) borrarBitacora(a);
});

/** Cuántas veces se anotó un paso. */
const veces = (paso: string) => leerBitacora(archivo).filter((l) => l === paso).length;

describe("un flujo durable", () => {
  it("corre cada paso una sola vez cuando no falla nada", async () => {
    const run = await start(tresPasos, [{ archivo, fallas: 0 }]);

    expect(await run.returnValue).toBe("uno-dos-tres");
    expect(await run.status).toBe("completed");
    expect(leerBitacora(archivo)).toEqual(["uno", "dos", "tres"]);
  });

  it("reintenta el paso que falló, y NO los que ya habían pasado", async () => {
    // El del medio se cae dos veces antes de andar.
    const run = await start(tresPasos, [{ archivo, fallas: 2 }]);

    // El resultado es el mismo: el reintento no se ve desde afuera.
    expect(await run.returnValue).toBe("uno-dos-tres");

    // Y acá está lo que importa. El paso del medio corrió tres veces —dos
    // fallas y la buena— mientras que el primero corrió UNA sola.
    //
    // Con `after()` esto era imposible: un fallo a mitad de camino se llevaba
    // todo, y volver a intentarlo era volver a empezar. Un tres en la línea de
    // abajo sería la prueba de que la durabilidad no existe.
    expect(veces("dos")).toBe(3);
    expect(veces("uno")).toBe(1);

    // Y el último corrió una sola vez, después de que el del medio saliera bien.
    expect(veces("tres")).toBe(1);
  });

  it("le da al flujo un identificador con el que se lo puede ir a buscar", async () => {
    // No es cosmético: es lo que permite preguntar después "¿este caso se
    // terminó de procesar?" sin depender de que alguien mirara los registros
    // en el momento justo.
    const run = await start(tresPasos, [{ archivo, fallas: 0 }]);
    expect(run.runId).toMatch(/^wrun_/);
    await run.returnValue;
  });
});
