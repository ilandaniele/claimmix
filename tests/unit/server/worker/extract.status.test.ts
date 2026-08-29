/**
 * Qué estado escribe el worker en el caso después de leer el mensaje.
 *
 * Estas cuatro ramas no las cubría NADA. Grepeando los seis archivos de test
 * que levantan el worker, las únicas apariciones de `status:` son el `recibido`
 * de entrada — ninguna afirma `info_faltante`, `confirmacion_pendiente`,
 * `requiere_especialista` ni `listo` como resultado.
 *
 * La decisión ya está extraída y probada como función pura en
 * `tests/unit/core/status-after-extraction.test.ts`. Lo de acá es la otra
 * mitad, y no es redundante: prueba que el worker le pase las señales que
 * corresponden y escriba lo que salga. Un test puro sobre la función no ve un
 * cableado invertido —pasarle los campos por confirmar donde van los
 * faltantes—, y eso es exactamente lo que un refactor rompe.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks, statusEscrito } from "./worker-harness";

const CASE_ID = "status-test-0000-0000-000000000001";
const TENANT_ID = "status-test-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(opciones: {
  necesitaEspecialista?: boolean;
  missing_fields?: string[];
  fields_pending_confirmation?: string[];
}): Promise<string | undefined> {
  vi.resetModules();

  const espiaDeUpdate = vi.fn();
  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID),
    espiaDeUpdate,
    necesitaEspecialista: opciones.necesitaEspecialista ?? false,
    extractor: {
      missing_fields: opciones.missing_fields,
      fields_pending_confirmation: opciones.fields_pending_confirmation,
      requires_specialist: opciones.necesitaEspecialista ?? false,
      severity: opciones.necesitaEspecialista ? "high" : "medium",
    },
  });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  return statusEscrito(espiaDeUpdate);
}

describe("runEmailExtractionWorker — el estado que deja", () => {
  it("con todo completo y sin dudas, queda listo", async () => {
    expect(await correr({})).toBe("listo");
  });

  /*
   * `accident_date` y no `policy_number`, y esto lo descubrió el test.
   *
   * El worker filtra los `missing_fields` que declara el modelo contra lo que
   * el parser de respaldo SÍ encontró en el texto (extract.ts, paso e2). Y ese
   * parser emite `policy_number` a partir del asunto, así que declarar que
   * falta la póliza no producía `info_faltante`: quedaba en `listo`.
   *
   * Es el comportamiento correcto —si lo encontramos, no falta— pero significa
   * que un test de esta rama tiene que elegir un campo que el respaldo no
   * deduzca, o prueba lo contrario de lo que dice.
   */
  it("con un dato faltante, queda en info_faltante", async () => {
    expect(await correr({ missing_fields: ["accident_date"] })).toBe("info_faltante");
  });

  it("con un dato dudoso, queda a confirmar", async () => {
    expect(await correr({ fields_pending_confirmation: ["dni"] })).toBe(
      "confirmacion_pendiente"
    );
  });

  it("con severidad alta, va a especialista", async () => {
    expect(await correr({ necesitaEspecialista: true })).toBe("requiere_especialista");
  });
});

describe("runEmailExtractionWorker — la precedencia llega bien cableada", () => {
  /*
   * Acá está el valor de probarlo a nivel worker.
   *
   * Un test sobre la función pura no ve si alguien le pasa los campos por
   * confirmar donde van los faltantes: las dos entradas son números y las dos
   * ramas existen. Se nota solamente cuando las dos señales están prendidas a
   * la vez y el resultado sale al revés.
   */
  it("faltar un dato le gana a dudar de otro, también desde el worker", async () => {
    expect(
      await correr({
        missing_fields: ["accident_date"],
        fields_pending_confirmation: ["dni"],
      })
    ).toBe("info_faltante");
  });

  it("la severidad alta le gana a todo lo demás", async () => {
    expect(
      await correr({
        necesitaEspecialista: true,
        missing_fields: ["accident_date"],
        fields_pending_confirmation: ["dni"],
      })
    ).toBe("requiere_especialista");
  });
});
