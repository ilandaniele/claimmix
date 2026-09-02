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

import { QueryBuilder } from "drizzle-orm/pg-core";

import { customers } from "@/lib/db/schema";
import {
  armarFiltroDeBusqueda,
  type CustomerQuery,
} from "@/server/customers/list";
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

describe("el padrón se busca por los tres modos", () => {
  /*
   * Antes esto leía `clientes/page.tsx` como texto y buscaba tres palabras
   * adentro. Era una afirmación sobre el código, y el propio test lo decía:
   * montar un componente de servidor de Next con su sesión, su rol y su base
   * pedía más andamio que producto.
   *
   * Ya no hace falta. La búsqueda se mudó a `listCustomers`, que es una función
   * común —fue extraída justamente para poder probar el filtro sin fabricar una
   * petición HTTP— así que se puede mirar el SQL que sale, que es lo que
   * importa. Un grep del archivo equivocado pasa en verde con la búsqueda rota;
   * esto no.
   *
   * `QueryBuilder` arma la consulta sin conexión: no hay base de por medio.
   */
  const sqlDe = (query: Partial<CustomerQuery>) => {
    const { sql: texto, params } = new QueryBuilder()
      .select()
      .from(customers)
      .where(armarFiltroDeBusqueda({ page: 1, per_page: 25, ...query }))
      .toSQL();
    return { texto, params };
  };

  it("un DNI escrito con puntos compara los dígitos pelados de los dos lados", () => {
    const { texto, params } = sqlDe({ search: "27.654.321" });

    // El padrón guarda `27654321`; sin el `regexp_replace` no empareja nada.
    expect(texto).toContain("regexp_replace");
    expect(params).toContain("27654321");
  });

  it("el correo se busca por igualdad además de por subcadena", () => {
    const { texto, params } = sqlDe({ search: "ana@empresa.com" });

    expect(texto.toLowerCase()).toContain("lower");
    expect(params).toContain("ana@empresa.com");
  });

  it("busca en la columna de correo, no sólo en la de nombre", () => {
    const { texto } = sqlDe({ search: "ana" });

    // Dos ILIKE: uno por nombre y otro por correo. Con uno solo, escribir parte
    // de una dirección no encuentra a nadie.
    expect(texto.match(/ilike/gi) ?? []).toHaveLength(2);
  });

  it("«Ana» no se toma por un documento", () => {
    const { texto } = sqlDe({ search: "Ana" });

    /*
     * Si «Ana» normalizara a la cadena vacía y entrara igual a la comparación de
     * documento, devolvería a toda persona con el DNI en blanco: en vez de no
     * encontrar a nadie, encontraríamos a cualquiera.
     */
    expect(texto).not.toContain("regexp_replace");
  });

  it("los comodines de LIKE que escribe la persona se escapan", () => {
    const { params } = sqlDe({ search: "100%" });

    /*
     * Sin escapar, `%` empareja cualquier cosa y `_` cualquier carácter: buscar
     * «_» devuelve el padrón entero. Y quien busca no tiene forma de saber que
     * le contestaron cualquier cosa.
     *
     * Esto se rompió de verdad: la pantalla armaba el patrón a mano mientras el
     * módulo extraído usaba `ilikeAny`, que sí escapa. Dos implementaciones de
     * la misma búsqueda, y sólo una escapaba.
     */
    expect(params).toContain("%100\\%%");
  });

  it("una caja vacía no arma ningún filtro", () => {
    expect(armarFiltroDeBusqueda({ page: 1, per_page: 25 })).toBeUndefined();
    expect(armarFiltroDeBusqueda({ page: 1, per_page: 25, search: "   " })).toBeUndefined();
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

/*
 * Los filtros exactos de la API, que decían otra cosa que la búsqueda libre.
 *
 * `?search=27.903.415` encontraba a Elena Duarte y `?dni=27.903.415` devolvía
 * cero, en el mismo archivo y contra la misma columna. El mismo dato, dos
 * respuestas, según por qué parámetro entrara. Y cero es indistinguible de «esa
 * persona no está», que es exactamente el defecto que este archivo ya contaba
 * del buscador.
 */
describe("los filtros exactos de /api/customers", () => {
  const sqlDe = (query: Partial<CustomerQuery>) => {
    const { sql: texto, params } = new QueryBuilder()
      .select()
      .from(customers)
      .where(armarFiltroDeBusqueda({ page: 1, per_page: 25, ...query }))
      .toSQL();
    return { texto, params };
  };

  it("?dni con puntos compara los dígitos pelados, igual que la caja", () => {
    const { texto, params } = sqlDe({ dni: "27.903.415" });

    expect(texto).toContain("regexp_replace");
    expect(params).toContain("27903415");
    // Y sobre todo: no compara el crudo, que es lo que devolvía cero.
    expect(params).not.toContain("27.903.415");
  });

  it("?email en mayúsculas encuentra igual", () => {
    const { texto, params } = sqlDe({ email: "Elena.Duarte@Example.com" });

    expect(texto.toLowerCase()).toContain("lower");
    expect(params).toContain("elena.duarte@example.com");
  });

  it("un ?dni que no puede ser un documento no devuelve a cualquiera", () => {
    /*
     * La guarda que importa. `?dni=—` normaliza a la cadena vacía, y comparar
     * vacío contra la columna normalizada devuelve a TODA persona con el
     * documento en blanco. Recibir a cualquiera es mucho peor que no encontrar
     * a nadie, y con la confianza de una coincidencia por documento.
     */
    const { texto, params } = sqlDe({ dni: "—" });

    expect(params).not.toContain("");
    expect(texto.toLowerCase()).toContain("false");
  });

  it("los dos parámetros de DNI dan el mismo SQL de comparación", () => {
    // La propiedad de fondo: mientras haya dos formas de comparar el mismo
    // campo en el mismo archivo, se van a separar otra vez.
    const porCaja = sqlDe({ search: "27.903.415" });
    const porFiltro = sqlDe({ dni: "27.903.415" });

    expect(porCaja.params).toContain("27903415");
    expect(porFiltro.params).toContain("27903415");
    expect(porCaja.texto).toContain("regexp_replace");
    expect(porFiltro.texto).toContain("regexp_replace");
  });
});
