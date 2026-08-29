/**
 * Con qué datos se busca al cliente.
 *
 * El modelo devuelve dos formas de lo mismo: `fields[]` y el objeto tipado
 * `extracted_fields`. El worker arma la búsqueda con `fields[]` y después le
 * SUPERPONE `extracted_fields`, pero sólo lo que traiga valor.
 *
 * Ese «sólo lo que traiga valor» es semántico y no cosmético, y no lo cubría
 * nada. A esa altura `fields[]` ya tiene lo que salió de la hidratación y del
 * parser de respaldo; un `""` del modelo —que los manda— borraría un valor que
 * SÍ encontramos en el texto, y el buscador se quedaría justo sin la clave por
 * la que iba a encontrar a la persona.
 *
 * Era nueve `if` alineados. Ahora es un bucle sobre la lista del esquema, y sin
 * este test el próximo que pase escribe `Object.assign` y pasa toda la suite.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

/*
 * Más tiempo del que da vitest por omisión, y no es por lentitud del código.
 *
 * Cada caso hace `vi.resetModules()` y vuelve a importar
 * `@/server/worker/extract`, que arrastra el grafo entero del worker. En una
 * máquina ociosa eso son ~1,2 s; con la CI corriendo otras cosas en paralelo
 * pasa los 5 s de omisión y el test falla por reloj sin que nada esté roto.
 *
 * Reproducido a propósito: con dos corridas de la suite compitiendo, el primer
 * caso de este archivo tira «Test timed out in 5000ms». Subir el tope acá y no
 * globalmente deja que un cuelgue de verdad en cualquier otro lado siga
 * saltando rápido.
 */
vi.setConfig({ testTimeout: 30_000 });


const CASE_ID = "overlay-test-0000-0000-000000000001";
const TENANT_ID = "overlay-test-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Corre el worker y devuelve los datos con los que se buscó al cliente. */
async function datosDeBusqueda(extractor: {
  fields?: Array<{ field_key: string; field_value: string; confidence: number; source: string }>;
  extracted_fields?: Record<string, string>;
}): Promise<Record<string, string | undefined>> {
  vi.resetModules();

  const { espiaDeBusqueda } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID),
    espiaDeUpdate: vi.fn(),
    extractor,
  });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  expect(espiaDeBusqueda).toHaveBeenCalled();
  return espiaDeBusqueda.mock.calls[0][1] as Record<string, string | undefined>;
}

const CAMPO = (clave: string, valor: string) => ({
  field_key: clave,
  field_value: valor,
  confidence: 0.9,
  source: "ai",
});

describe("el solapamiento de extracted_fields sobre fields[]", () => {
  it("un valor del modelo pisa al de fields[]", async () => {
    // La mitad obvia, pero sin ella el test de abajo lo cumpliría una función
    // que ignore `extracted_fields` por completo.
    const datos = await datosDeBusqueda({
      fields: [CAMPO("full_name", "El del parser")],
      extracted_fields: { full_name: "El del modelo" },
    });

    expect(datos.full_name).toBe("El del modelo");
  });

  it("una cadena vacía del modelo NO pisa lo que ya teníamos", async () => {
    // Acá está el punto. Un `Object.assign` dejaría `full_name: ""` y el
    // buscador se quedaría sin la clave por la que iba a encontrar a la persona.
    const datos = await datosDeBusqueda({
      fields: [CAMPO("full_name", "Juan Pérez"), CAMPO("dni", "30111222")],
      extracted_fields: { full_name: "", dni: "" },
    });

    expect(datos.full_name).toBe("Juan Pérez");
    expect(datos.dni).toBe("30111222");
  });

  it("una clave ausente en el modelo tampoco borra la de fields[]", async () => {
    const datos = await datosDeBusqueda({
      fields: [CAMPO("email", "juan@ejemplo.com")],
      extracted_fields: { full_name: "Juan Pérez" },
    });

    expect(datos.email).toBe("juan@ejemplo.com");
    expect(datos.full_name).toBe("Juan Pérez");
  });

  it("las nueve claves se superponen, no un puñado", async () => {
    /*
     * La lista va escrita a mano ACÁ, y es a propósito.
     *
     * La primera versión de este test armaba lo esperado a partir de
     * `CLAIM_FIELD_KEYS` —la misma lista que dice probar— y pasaba en verde
     * cuando la recorté a tres claves. Un test que itera lo que verifica no
     * verifica nada.
     *
     * Escrita a mano, es la especificación: si mañana el esquema crece, este
     * test falla y alguien decide a propósito si el campo nuevo también entra
     * a la búsqueda de clientes.
     */
    const LAS_NUEVE = [
      "full_name",
      "email",
      "phone",
      "dni",
      "policy_number",
      "accident_date",
      "accident_location",
      "accident_description",
      "claim_type",
    ];

    const delModelo = Object.fromEntries(
      LAS_NUEVE.map((k) => [k, `valor-${k}`])
    ) as Record<string, string>;

    const datos = await datosDeBusqueda({ fields: [], extracted_fields: delModelo });

    for (const clave of LAS_NUEVE) {
      expect(datos[clave]).toBe(`valor-${clave}`);
    }
  });

  it("la lista que usa el worker es la del esquema, entera", async () => {
    // La otra mitad: que `CLAIM_FIELD_KEYS` no se haya recortado ni desviado
    // del esquema del que dice salir.
    const { CLAIM_FIELD_KEYS, ClaimFieldsSchema } = await import(
      "@/lib/schemas/extracted-claim"
    );

    expect(CLAIM_FIELD_KEYS).toEqual(Object.keys(ClaimFieldsSchema.shape));
    expect(CLAIM_FIELD_KEYS).toHaveLength(9);
  });
});
