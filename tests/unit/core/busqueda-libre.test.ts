/**
 * La caja de búsqueda de /clientes decía tres cosas y hacía una.
 *
 * El placeholder es, textual, «Buscar por nombre, DNI o email...», y la consulta
 * hacía `ilike(full_name, '%…%')` y nada más. Un especialista que escribía el
 * DNI del asegurado —el dato que tiene a mano cuando lo llama por teléfono—
 * recibía «no hay clientes».
 *
 * Cero resultados es indistinguible de «esa persona no está en el padrón»: la
 * pantalla no fallaba, mentía.
 */

import { describe, it, expect } from "vitest";

import { interpretarBusqueda } from "@/core/matching/busqueda-libre";

describe("interpretarBusqueda", () => {
  it("un documento con puntos se reconoce como DNI, en dígitos pelados", () => {
    // El padrón guarda `27654321` y la persona escribe como se escribe acá.
    expect(interpretarBusqueda("27.654.321")?.dni).toBe("27654321");
    expect(interpretarBusqueda("27654321")?.dni).toBe("27654321");
  });

  it("una dirección entera se reconoce como correo, en minúsculas", () => {
    expect(interpretarBusqueda("Juan.Perez@Ejemplo.com")?.email).toBe(
      "juan.perez@ejemplo.com"
    );
  });

  it("un nombre no es ni una cosa ni la otra", () => {
    const r = interpretarBusqueda("Cecilia Ferrari");
    expect(r?.dni).toBeNull();
    expect(r?.email).toBeNull();
    expect(r?.nombre).toBe("Cecilia Ferrari");
  });

  it("un texto corto con dígitos NO cuenta como DNI", () => {
    /*
     * La guarda que hace que todo lo demás sea seguro. Sin ella, buscar «Ana»
     * normaliza a la cadena vacía y una comparación contra la columna de
     * documento devolvería a toda persona con el documento vacío: en vez de no
     * encontrar a nadie, encontraríamos a cualquiera. Es la misma guarda que
     * usa el buscador de casos.
     */
    expect(interpretarBusqueda("Ana")?.dni).toBeNull();
    expect(interpretarBusqueda("123")?.dni).toBeNull();
    expect(interpretarBusqueda("—")?.dni).toBeNull();
  });

  it("el nombre SIEMPRE viaja, aunque parezca un documento", () => {
    // Los tres modos no son excluyentes: un padrón puede tener un nombre de
    // fantasía con números, y descartarlo sería el mismo error al revés.
    expect(interpretarBusqueda("27654321")?.nombre).toBe("27654321");
  });

  it("una caja vacía no busca nada", () => {
    expect(interpretarBusqueda("")).toBeNull();
    expect(interpretarBusqueda("   ")).toBeNull();
  });
});

describe("la pantalla usa los tres modos", () => {
  it("la consulta compara el DNI con los dígitos pelados de los dos lados", async () => {
    /*
     * Afirmación sobre el código, y lo digo: montar un componente de servidor de
     * Next con su sesión, su rol y su base pediría más andamio que producto. Lo
     * que esto impide es lo que efectivamente pasaba — que la consulta mire sólo
     * `full_name` mientras la caja promete tres modos.
     */
    const fuente = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/(app)/clientes/page.tsx", "utf8")
    );

    expect(fuente).toContain("interpretarBusqueda");
    expect(fuente).toContain("regexp_replace");
    expect(fuente).toContain("customers.email");
  });

  it("y el texto de la caja sigue prometiendo los tres", async () => {
    // Si alguien recorta la promesa, este test se cae y le recuerda que la
    // alternativa era recortar la consulta.
    const i18n = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/i18n/es-AR.ts", "utf8")
    );
    expect(i18n).toContain("Buscar por nombre, DNI o email");
  });
});
