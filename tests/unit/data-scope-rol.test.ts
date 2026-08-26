/**
 * Que la capa se niegue a servir con un rol que saltea RLS.
 *
 * Es la única suposición sobre la que se apoya todo el aislamiento, y hasta
 * ahora no la comprobaba nadie. Si `DATABASE_URL_APP` apunta a un rol con
 * BYPASSRLS, las políticas no se aplican; y como estas consultas ya no llevan
 * `WHERE tenant_id`, devuelven las filas de **todos** los inquilinos con un 200
 * impecable.
 *
 * No es hipotético. Pasó al armar los tests de integración: se apuntó
 * `DATABASE_URL_APP` a la cadena del ensayo —que es la del dueño— y `/api/cases`
 * sirvió casos de tres aseguradoras distintas. Lo agarró un test que comparaba
 * los `tenant_id` de la respuesta. Sin ese test, la pantalla se veía perfecta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Lo que responde el catálogo sobre el rol de turno. */
let rol = { usuario: "claimmix_app", saltea: false, es_super: false };

vi.mock("@neondatabase/serverless", () => ({ neon: () => ({}) }));

vi.mock("drizzle-orm/neon-http", () => ({
  drizzle: () => ({
    execute: (q: unknown) => {
      const texto = JSON.stringify(q);
      // La consulta del guardia se reconoce por su contenido; cualquier otra
      // devuelve una fila vacía.
      if (texto.includes("rolbypassrls")) return Promise.resolve([{ ...rol }]);
      return { tipo: "consulta", q };
    },
    batch: () => Promise.resolve([{}, []]),
  }),
}));

const APP = "postgresql://claimmix_app:x@ejemplo.neon.tech/neondb";
const CTX = { tenantId: "aaaaaaaa-0000-0000-0000-00000000000a" };

let guardada: string | undefined;

beforeEach(() => {
  guardada = process.env.DATABASE_URL_APP;
  process.env.DATABASE_URL_APP = APP;
  rol = { usuario: "claimmix_app", saltea: false, es_super: false };
  // El resultado del chequeo se cachea por proceso a propósito —cuesta una
  // consulta y no debería repetirse— así que cada test necesita el módulo
  // limpio o mediría el caché del anterior.
  vi.resetModules();
});

afterEach(() => {
  if (guardada === undefined) delete process.env.DATABASE_URL_APP;
  else process.env.DATABASE_URL_APP = guardada;
});

describe("el rol con el que entra la capa", () => {
  it("deja pasar al rol restringido", async () => {
    const { enTenant } = await import("@/data/scope");
    await expect(
      enTenant(CTX, (db) => db.execute("q") as never)
    ).resolves.toEqual([]);
  });

  it("rompe con un rol que tiene BYPASSRLS", async () => {
    rol = { usuario: "neondb_owner", saltea: true, es_super: false };
    const { enTenant } = await import("@/data/scope");

    await expect(enTenant(CTX, (db) => db.execute("q") as never)).rejects.toThrow(
      /BYPASSRLS/
    );
  });

  it("rompe con un superusuario", async () => {
    rol = { usuario: "postgres", saltea: false, es_super: true };
    const { enTenant } = await import("@/data/scope");

    await expect(enTenant(CTX, (db) => db.execute("q") as never)).rejects.toThrow(
      /superusuario/
    );
  });

  it("el mensaje dice qué variable arreglar y con qué", async () => {
    rol = { usuario: "neondb_owner", saltea: true, es_super: false };
    const { enTenant } = await import("@/data/scope");
    const error = await enTenant(CTX, (db) => db.execute("q") as never).catch(
      (e: Error) => e
    );

    // El que se lo encuentre tiene que poder arreglarlo sin leer el código.
    const m = (error as Error).message;
    expect(m).toContain("DATABASE_URL_APP");
    expect(m).toContain("claimmix_app");
    expect(m).toContain("pnpm rol-app");
    expect(m).toMatch(/datos de TODOS/);
  });

  it("enTenantVarias tiene la misma puerta", async () => {
    rol = { usuario: "neondb_owner", saltea: true, es_super: false };
    const { enTenantVarias } = await import("@/data/scope");

    // Dos puertas al mismo cuarto: cerrar una sola no cierra nada.
    await expect(
      enTenantVarias(CTX, (db) => [db.execute("q") as never])
    ).rejects.toThrow(/BYPASSRLS/);
  });

  it("no vuelve a preguntar en cada consulta", async () => {
    const consultadas: string[] = [];
    vi.doMock("drizzle-orm/neon-http", () => ({
      drizzle: () => ({
        execute: (q: unknown) => {
          const texto = JSON.stringify(q);
          if (texto.includes("rolbypassrls")) {
            consultadas.push("guardia");
            return Promise.resolve([{ ...rol }]);
          }
          return { tipo: "consulta", q };
        },
        batch: () => Promise.resolve([{}, []]),
      }),
    }));

    const { enTenant } = await import("@/data/scope");
    await enTenant(CTX, (db) => db.execute("a") as never);
    await enTenant(CTX, (db) => db.execute("b") as never);
    await enTenant(CTX, (db) => db.execute("c") as never);

    // Una vez por proceso. Preguntarlo en cada consulta duplicaría los viajes
    // de red de toda la aplicación para comprobar algo que no cambia.
    expect(consultadas).toHaveLength(1);
  });
});
