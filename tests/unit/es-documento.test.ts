/**
 * Qué es un archivo que sólo puede mandar la persona, y qué es un dato.
 *
 * La distinción no es cosmética. Un dato lo podemos averiguar nosotros: el
 * número de póliza está en nuestro propio padrón, y buscarlo es mejor que
 * pedírselo a alguien que acaba de chocar. Un documento no: la denuncia
 * policial, el parte amistoso y las fotos de los daños son archivos que existen
 * del lado de la persona, y ninguna búsqueda los produce.
 *
 * Existe porque el agente podía declarar en `plan.resolved` que había
 * «resuelto» la denuncia policial, y el orquestador cerraba el pedido: el caso
 * podía exportarse a la aseguradora diciendo que teníamos el parte policial de
 * un robo, cuando lo que teníamos era la palabra del modelo.
 */

import { describe, it, expect } from "vitest";

import { isDocument } from "@/lib/labels/claim-fields";

describe("isDocument", () => {
  it("los archivos que sólo puede mandar la persona", () => {
    expect(isDocument("denuncia_policial")).toBe(true);
    expect(isDocument("parte_amistoso")).toBe(true);
    expect(isDocument("fotos_danos")).toBe(true);
    expect(isDocument("licencia_conducir")).toBe(true);
    expect(isDocument("informe_bomberos")).toBe(true);
  });

  it("los datos que podemos averiguar nosotros", () => {
    expect(isDocument("policy_number")).toBe(false);
    expect(isDocument("dni")).toBe(false);
    expect(isDocument("full_name")).toBe(false);
    expect(isDocument("phone")).toBe(false);
    expect(isDocument("accident_date")).toBe(false);
  });

  it("los alias en castellano dan lo mismo que su clave canónica", () => {
    // El extractor emite `numero_poliza` o `policy_number` según el día, y una
    // regla que sólo mirara uno de los dos nombres se saltearía la mitad.
    expect(isDocument("numero_poliza")).toBe(isDocument("policy_number"));
    expect(isDocument("dni_asegurado")).toBe(isDocument("dni"));
    expect(isDocument("telefono_contacto")).toBe(isDocument("phone"));
  });

  it("una clave que no conocemos NO se trata como documento", () => {
    /*
     * Decidido a propósito, y en contra del reflejo de «ante la duda, bloquear».
     *
     * Devolver `true` por las dudas mataría la mitad útil —anotar el dato que
     * encontramos en nuestra propia base— cada vez que el extractor invente un
     * nombre nuevo, que lo hace seguido. El riesgo del otro lado es acotado:
     * una clave desconocida no tiene fila en `missing_docs` con ese nombre, así
     * que no hay pedido que cerrar.
     */
    expect(isDocument("campo_que_el_modelo_acaba_de_inventar")).toBe(false);
    expect(isDocument("")).toBe(false);
  });

  it("hay documentos Y datos en la tabla, o esto no distinguiría nada", () => {
    /*
     * El control que hace que los dos bloques de arriba signifiquen algo. Si
     * `kind: "documento"` desapareciera de la tabla, todas las afirmaciones de
     * «los datos» seguirían pasando y las de «los archivos» se caerían — pero
     * si alguien las "arreglara" invirtiéndolas, este test avisa que la tabla
     * dejó de tener dos clases.
     */
    const claves = [
      "denuncia_policial",
      "parte_amistoso",
      "policy_number",
      "dni",
      "full_name",
    ];
    const documentos = claves.filter(isDocument);
    expect(documentos.length).toBeGreaterThan(0);
    expect(documentos.length).toBeLessThan(claves.length);
  });
});
