/**
 * Qué base le toca a cada inquilino.
 *
 * `bases.ts` es la mitad pura de la elección: arma el nombre `t_<hex>` desde el id
 * y la cadena de conexión con ese nombre. No consulta nada, así que acá no hay
 * mocks. Cómo se usa desde la capa de datos —un cliente por base, el rol
 * comprobado una vez por host— lo prueba `scope-base-por-cliente.test.ts`.
 *
 * El nombre termina en un `CREATE DATABASE` y en una cadena de conexión, y es lo
 * que separa los datos de una aseguradora de los de otra: por eso los casos de
 * entrada mala pesan tanto como los buenos.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CENTINELA,
  basePorCliente,
  baseDelInquilino,
  cadenaConBase,
  esBaseInexistente,
  nombreDeBase,
} from "@/data/bases";

const TENANT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("basePorCliente", () => {
  it("está apagada si la variable no está", () => {
    vi.stubEnv("BASE_POR_CLIENTE", "");
    expect(basePorCliente()).toBe(false);
  });

  it("sólo el 1 la prende", () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    expect(basePorCliente()).toBe(true);

    for (const valor of ["0", "true", "si", " 1", "1 ", "yes"]) {
      vi.stubEnv("BASE_POR_CLIENTE", valor);
      expect(basePorCliente()).toBe(false);
    }
  });
});

describe("nombreDeBase", () => {
  it("es t_ y los 32 hex del id, sin guiones", () => {
    expect(nombreDeBase(TENANT_A)).toBe("t_aaaaaaaa11114111" + "8111aaaaaaaaaaaa");
    expect(nombreDeBase(TENANT_A)).toMatch(/^t_[0-9a-f]{32}$/);
  });

  it("sale en minúscula aunque el id venga en mayúscula", () => {
    expect(nombreDeBase(TENANT_A.toUpperCase())).toBe(nombreDeBase(TENANT_A));
  });

  it("dos inquilinos distintos, dos bases distintas", () => {
    expect(nombreDeBase(TENANT_A)).not.toBe(nombreDeBase(TENANT_B));
  });

  it("el centinela también da nombre: lo que lo manda a control es baseDelInquilino", () => {
    expect(nombreDeBase(CENTINELA)).toBe("t_" + "0".repeat(32));
  });

  it.each([
    ["vacío", ""],
    ["un texto cualquiera", "no-es-un-uuid"],
    ["sin guiones", TENANT_A.replaceAll("-", "")],
    ["uno de más", TENANT_A + "0"],
    ["un caracter que no es hex", TENANT_A.replace("a", "g")],
    ["con espacios alrededor", ` ${TENANT_A} `],
    ["un intento de inyección", `${TENANT_A}"; DROP DATABASE neondb; --`],
    ["una ruta", "../neondb"],
  ])("tira con %s", (_caso, id) => {
    expect(() => nombreDeBase(id)).toThrow(/no es un uuid/);
  });

  it("tira con lo que ni siquiera es un texto", () => {
    expect(() => nombreDeBase(undefined as unknown as string)).toThrow(/no es un uuid/);
    expect(() => nombreDeBase(null as unknown as string)).toThrow(/no es un uuid/);
    expect(() => nombreDeBase(42 as unknown as string)).toThrow(/no es un uuid/);
  });
});

describe("baseDelInquilino", () => {
  it("con la bandera apagada es control para todos, incluso un id raro", () => {
    vi.stubEnv("BASE_POR_CLIENTE", "0");
    expect(baseDelInquilino(TENANT_A)).toBeNull();
    expect(baseDelInquilino(TENANT_B)).toBeNull();
    // Hoy un id que no es uuid no frena nada acá; apagada, tampoco.
    expect(baseDelInquilino("no-es-un-uuid")).toBeNull();
  });

  describe("con la bandera prendida", () => {
    it("un inquilino real tiene su base", () => {
      vi.stubEnv("BASE_POR_CLIENTE", "1");
      expect(baseDelInquilino(TENANT_A)).toBe(nombreDeBase(TENANT_A));
      expect(baseDelInquilino(TENANT_B)).toBe(nombreDeBase(TENANT_B));
      expect(baseDelInquilino(TENANT_A)).not.toBe(baseDelInquilino(TENANT_B));
    });

    it("null, undefined, vacío y el centinela son control", () => {
      vi.stubEnv("BASE_POR_CLIENTE", "1");
      expect(baseDelInquilino(null)).toBeNull();
      expect(baseDelInquilino(undefined)).toBeNull();
      expect(baseDelInquilino("")).toBeNull();
      expect(baseDelInquilino(CENTINELA)).toBeNull();
    });

    it("un id que no es uuid tira, en vez de mandar la consulta a otra parte", () => {
      vi.stubEnv("BASE_POR_CLIENTE", "1");
      expect(() => baseDelInquilino("no-es-un-uuid")).toThrow(/no es un uuid/);
    });
  });
});

describe("cadenaConBase", () => {
  const CONTROL = "postgresql://claimmix_app:fake-pass@ep-test-pooler.example.com/neondb?sslmode=require";

  it("cambia sólo la base", () => {
    expect(cadenaConBase(CONTROL, "t_abc")).toBe(
      "postgresql://claimmix_app:fake-pass@ep-test-pooler.example.com/t_abc?sslmode=require"
    );
  });

  it("conserva usuario, clave codificada, host y todos los parámetros", () => {
    const larga =
      "postgresql://claimmix_app:fake%40pass%2F@ep-test-pooler.example.com:5432/neondb?sslmode=require&channel_binding=require";
    expect(cadenaConBase(larga, "t_abc")).toBe(
      "postgresql://claimmix_app:fake%40pass%2F@ep-test-pooler.example.com:5432/t_abc?sslmode=require&channel_binding=require"
    );
  });

  it("anda con una cadena sin base ni parámetros", () => {
    expect(cadenaConBase("postgres://u:fake-pass@host.example.com", "t_abc")).toBe(
      "postgres://u:fake-pass@host.example.com/t_abc"
    );
  });

  it("no toca la cadena que recibe", () => {
    const copia = CONTROL;
    cadenaConBase(CONTROL, "t_abc");
    expect(CONTROL).toBe(copia);
  });

  it("tira con algo que no es una cadena de conexión", () => {
    expect(() => cadenaConBase("no es una url", "t_abc")).toThrow();
  });
});

describe("esBaseInexistente", () => {
  it("reconoce el 3D000 del driver", () => {
    expect(esBaseInexistente(Object.assign(new Error("no existe"), { code: "3D000" }))).toBe(true);
  });

  it("y el que drizzle deja en `cause`", () => {
    const e = new Error("Failed query", { cause: Object.assign(new Error("no existe"), { code: "3D000" }) });
    expect(esBaseInexistente(e)).toBe(true);
  });

  it("no confunde otro código de Postgres", () => {
    expect(esBaseInexistente(Object.assign(new Error("x"), { code: "42P01" }))).toBe(false);
    expect(esBaseInexistente(Object.assign(new Error("x"), { code: "28P01" }))).toBe(false);
    expect(
      esBaseInexistente(new Error("x", { cause: Object.assign(new Error("y"), { code: "57P01" }) }))
    ).toBe(false);
  });

  it("no tira con lo que no es un error", () => {
    expect(esBaseInexistente(null)).toBe(false);
    expect(esBaseInexistente(undefined)).toBe(false);
    expect(esBaseInexistente("3D000")).toBe(false);
    expect(esBaseInexistente(3000)).toBe(false);
    expect(esBaseInexistente(new Error("sin código"))).toBe(false);
  });
});
