/**
 * Qué le manda a la base la capa de datos, exactamente y en qué orden.
 *
 * El aislamiento entre aseguradoras se apoya en un detalle chiquito: cada
 * consulta viaja en un lote de dos, y el `set_config` que fija el inquilino va
 * **primero**. Si fuera segundo, la consulta correría sin contexto; con RLS
 * activo devolvería cero filas, y sin RLS devolvería las de todos.
 *
 * Ninguna de las dos fallas se ve desde afuera como un error. La primera parece
 * "no hay casos todavía"; la segunda parece que anda bien. Por eso lo que se
 * mira acá no es el resultado sino **el lote que sale**: qué sentencias lleva,
 * en qué orden, y con qué inquilino.
 *
 * Los tests que ya existen prueban lo otro —que sin `DATABASE_URL_APP` rompe
 * en vez de caer al rol que saltea RLS— en `data-scope-sin-rol.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Los lotes que la capa mandó, en orden. */
const lotes: unknown[][] = [];
/** Con qué cadena de conexión se construyó cada cliente. */
const cadenas: string[] = [];
/** Lo que el próximo `batch` va a devolver. */
let respuesta: unknown[] = [];

vi.mock("@neondatabase/serverless", () => ({
  // El cliente crudo no se usa para nada acá: drizzle lo envuelve. Se devuelve
  // la cadena para poder ver, más abajo, con cuál se construyó.
  neon: (cadena: string) => {
    cadenas.push(cadena);
    return { __cadena: cadena };
  },
}));

vi.mock("drizzle-orm/neon-http", () => ({
  drizzle: (crudo: { __cadena: string }) => ({
    __cadena: crudo.__cadena,
    // Cada "consulta" es sólo una etiqueta: lo que importa es cuál llega y en
    // qué posición, no que sea SQL de verdad.
    execute: (q: unknown) => ({ tipo: "execute", q }),
    batch: (consultas: unknown[]) => {
      lotes.push(consultas);
      return Promise.resolve(respuesta);
    },
  }),
}));

const APP = "postgresql://claimmix_app:secreta@ejemplo.neon.tech/neondb";
const CTX = { tenantId: "aaaaaaaa-0000-0000-0000-00000000000a" };
const OTRO = { tenantId: "bbbbbbbb-0000-0000-0000-00000000000b" };

let guardada: string | undefined;

beforeEach(async () => {
  guardada = process.env.DATABASE_URL_APP;
  process.env.DATABASE_URL_APP = APP;
  lotes.length = 0;
  cadenas.length = 0;
  respuesta = [];
  // El módulo cachea el cliente entre llamadas. Sin resetear, el primer test
  // que corra deja el cliente armado y los demás no vuelven a construirlo —
  // con lo cual el test del caché mediría el orden de ejecución, no el caché.
  vi.resetModules();
});

afterEach(() => {
  if (guardada === undefined) delete process.env.DATABASE_URL_APP;
  else process.env.DATABASE_URL_APP = guardada;
});

/** El SQL que lleva una sentencia, como texto plano. */
function textoDe(sentencia: unknown): string {
  const q = (sentencia as { q?: { queryChunks?: unknown[] } })?.q;
  return JSON.stringify(q ?? sentencia);
}

describe("el lote que sale hacia la base", () => {
  it("pone el contexto PRIMERO y la consulta después", async () => {
    const { enTenant } = await import("@/data/scope");
    respuesta = [{ contexto: true }, [{ id: "caso-1" }]];

    await enTenant(CTX, (db) => db.execute("la consulta") as never);

    expect(lotes).toHaveLength(1);
    const [lote] = lotes;
    expect(lote).toHaveLength(2);

    // Primera: el set_config, con ESTE inquilino.
    expect(textoDe(lote[0])).toContain("set_config");
    expect(textoDe(lote[0])).toContain(CTX.tenantId);

    // Segunda: la consulta de quien llamó, tal cual.
    expect((lote[1] as { q: string }).q).toBe("la consulta");
  });

  it("devuelve el resultado de la consulta, no el del set_config", async () => {
    const { enTenant } = await import("@/data/scope");
    const filas = [{ id: "caso-1" }, { id: "caso-2" }];
    respuesta = [{ set_config: CTX.tenantId }, filas];

    const salida = await enTenant(CTX, (db) => db.execute("q") as never);

    // Si devolviera el primero, quien llame recibiría la respuesta del
    // set_config en vez de sus filas — y `filas.length` daría 1 en vez de 2,
    // que se lee como "hay un caso" y no como "esto está mal".
    expect(salida).toBe(filas);
  });

  it("manda el inquilino que se le pasa, y no el de la llamada anterior", async () => {
    const { enTenant } = await import("@/data/scope");
    respuesta = [{}, []];

    await enTenant(CTX, (db) => db.execute("a") as never);
    await enTenant(OTRO, (db) => db.execute("b") as never);

    expect(textoDe(lotes[0][0])).toContain(CTX.tenantId);
    expect(textoDe(lotes[1][0])).toContain(OTRO.tenantId);
    // Y el segundo no arrastra el primero: si el cliente cacheado guardara el
    // contexto entre llamadas, la segunda consulta correría como la primera
    // aseguradora. Es la fuga más silenciosa que puede tener esta capa.
    expect(textoDe(lotes[1][0])).not.toContain(CTX.tenantId);
  });
});

describe("varias consultas en un viaje", () => {
  it("pone el contexto primero y después todas, en orden", async () => {
    const { enTenantVarias } = await import("@/data/scope");
    respuesta = [{}, ["casos"], ["documentos"], ["mensajes"]];

    await enTenantVarias(CTX, (db) => [
      db.execute("casos") as never,
      db.execute("documentos") as never,
      db.execute("mensajes") as never,
    ]);

    const [lote] = lotes;
    expect(lote).toHaveLength(4);
    expect(textoDe(lote[0])).toContain("set_config");
    expect((lote[1] as { q: string }).q).toBe("casos");
    expect((lote[2] as { q: string }).q).toBe("documentos");
    expect((lote[3] as { q: string }).q).toBe("mensajes");
  });

  it("descarta el resultado del contexto y devuelve el resto alineado", async () => {
    const { enTenantVarias } = await import("@/data/scope");
    respuesta = [{ set_config: "x" }, ["casos"], ["documentos"]];

    const [casos, documentos] = await enTenantVarias<[string[], string[]]>(
      CTX,
      (db) => [db.execute("casos") as never, db.execute("documentos") as never]
    );

    // El corrimiento de uno es el error que este test cuida. Si no se
    // descartara el primero, `casos` sería la respuesta del set_config y
    // `documentos` serían los casos: dos listas que existen, con los datos
    // equivocados adentro, y ningún error en el medio.
    expect(casos).toEqual(["casos"]);
    expect(documentos).toEqual(["documentos"]);
  });

  it("aguanta una sola consulta", async () => {
    const { enTenantVarias } = await import("@/data/scope");
    respuesta = [{}, ["sola"]];

    const salida = await enTenantVarias<[string[]]>(CTX, (db) => [
      db.execute("sola") as never,
    ]);

    expect(salida).toEqual([["sola"]]);
  });
});

describe("el cliente", () => {
  it("se construye una sola vez mientras la cadena no cambie", async () => {
    const { enTenant } = await import("@/data/scope");
    respuesta = [{}, []];

    await enTenant(CTX, (db) => db.execute("a") as never);
    await enTenant(CTX, (db) => db.execute("b") as never);
    await enTenant(OTRO, (db) => db.execute("c") as never);

    // Tres consultas, una sola conexión. No es sólo eficiencia: en serverless,
    // abrir una conexión por consulta agota el límite del plan bajo carga.
    expect(cadenas).toEqual([APP]);
  });

  it("se rehace si la cadena de conexión cambia", async () => {
    const { enTenant } = await import("@/data/scope");
    respuesta = [{}, []];

    await enTenant(CTX, (db) => db.execute("a") as never);

    // Pasa de verdad: al rotar la contraseña del rol, el proceso que sigue vivo
    // tiene que dejar de usar la vieja. Un cliente cacheado por siempre
    // seguiría fallando la autenticación hasta que alguien reinicie.
    const nueva = APP.replace("secreta", "rotada");
    process.env.DATABASE_URL_APP = nueva;
    await enTenant(CTX, (db) => db.execute("b") as never);

    expect(cadenas).toEqual([APP, nueva]);
  });

  it("recorta los espacios de la cadena", async () => {
    const { enTenant } = await import("@/data/scope");
    respuesta = [{}, []];
    // Un salto de línea al final es lo que queda cuando alguien pega la cadena
    // en un panel de variables de entorno.
    process.env.DATABASE_URL_APP = `  ${APP}\n`;

    await enTenant(CTX, (db) => db.execute("a") as never);

    expect(cadenas).toEqual([APP]);
  });
});

describe("una promesa no es una consulta", () => {
  it("rechaza un `.catch()` pegado al final de la cadena", async () => {
    const { enTenant } = await import("@/data/scope");

    // Este es el error que se coló en quince lugares al migrar, y que no
    // detectó ningún test: el puente que los tests usan hace
    // `Promise.resolve(armar(db))`, que con una promesa funciona igual. Es más
    // permisivo que `batch`, así que escondía exactamente esto.
    //
    // En producción salía como `query._prepare is not a function`, tirado desde
    // adentro de drizzle, con quince líneas de stack de node_modules y ninguna
    // mención al `.catch` ni a la capa.
    await expect(
      enTenant({ tenantId: "x" }, (db) =>
        // `Promise.resolve(...)` es lo que deja atrás un `.catch()` sobre una
        // cadena de drizzle: una promesa común, sin `_prepare`.
        Promise.resolve(db.execute("q")).catch(() => []) as never
      )
    ).rejects.toThrow(/una promesa, no una consulta/);
  });

  it("el mensaje dice dónde va el .catch", async () => {
    const { enTenant } = await import("@/data/scope");
    const error = await enTenant({ tenantId: "x" }, (db) =>
      Promise.resolve(db.execute("q")).then((x) => x) as never
    ).catch((e: Error) => e);

    // No alcanza con rechazar: el que se lo encuentre tiene que saber qué
    // escribir distinto sin ir a leer la implementación.
    expect((error as Error).message).toContain("enTenant(ctx, (db) => db.select()...)");
  });

  it("enTenantVarias revisa TODAS, no sólo la primera", async () => {
    const { enTenantVarias } = await import("@/data/scope");
    respuesta = [{}, [], []];

    // La segunda es la rota. Revisar sólo la primera dejaría pasar el lote y
    // el error volvería a salir desde adentro de drizzle.
    await expect(
      enTenantVarias({ tenantId: "x" }, (db) => [
        db.execute("buena") as never,
        Promise.resolve(db.execute("mala")).catch(() => []) as never,
      ])
    ).rejects.toThrow(/una promesa, no una consulta/);
  });

  it("deja pasar una consulta normal", async () => {
    // El guardia tiene que distinguir, no bloquear todo: los constructores de
    // drizzle son "thenable" pero no son `Promise`, y ésa es la diferencia.
    const { enTenant } = await import("@/data/scope");
    respuesta = [{}, ["fila"]];

    await expect(
      enTenant({ tenantId: "x" }, (db) => db.execute("q") as never)
    ).resolves.toEqual(["fila"]);
  });
});
