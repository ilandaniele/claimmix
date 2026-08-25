/**
 * La capa de datos sin `DATABASE_URL_APP` tiene que romper, no arreglárselas.
 *
 * Este test existe por un error que estuvo a punto de deployarse. La primera
 * versión de la capa caía a `DATABASE_URL` cuando faltaba la del rol
 * restringido, avisando por consola, con el argumento de que "la capa funciona
 * igual y sólo se pierde la defensa".
 *
 * Era falso. Las consultas que pasan por esta capa **ya no llevan
 * `WHERE tenant_id`**: el filtro lo pone la base. Con el rol viejo —que tiene
 * BYPASSRLS— las políticas no se aplican, así que esa consulta sin filtro
 * devuelve los datos de **todos** los inquilinos. El respaldo no degradaba la
 * defensa: fabricaba la fuga exacta que la capa existe para impedir.
 *
 * Si alguien vuelve a agregar ese respaldo "para que no rompa en desarrollo",
 * este test se pone en rojo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { enTenant, enTenantVarias } from "@/data/scope";
import { sql } from "drizzle-orm";

const CTX = { tenantId: "11111111-1111-1111-1111-111111111111" };

describe("la capa de datos sin el rol restringido", () => {
  let guardadas: { app?: string; vieja?: string };

  beforeEach(() => {
    guardadas = {
      app: process.env.DATABASE_URL_APP,
      vieja: process.env.DATABASE_URL,
    };
    delete process.env.DATABASE_URL_APP;
    // A propósito: la vieja SÍ está. Es el escenario peligroso — hay a dónde
    // caerse. Un test que borre las dos probaría algo mucho más flojo.
    process.env.DATABASE_URL = "postgresql://duenio:x@ejemplo.neon.tech/neondb";
  });

  afterEach(() => {
    if (guardadas.app === undefined) delete process.env.DATABASE_URL_APP;
    else process.env.DATABASE_URL_APP = guardadas.app;
    if (guardadas.vieja === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = guardadas.vieja;
  });

  it("enTenant rompe en vez de usar el rol que saltea RLS", async () => {
    await expect(
      enTenant(CTX, (db) => db.execute(sql`SELECT 1`))
    ).rejects.toThrow(/DATABASE_URL_APP/);
  });

  it("enTenantVarias también", async () => {
    await expect(
      enTenantVarias(CTX, (db) => [db.execute(sql`SELECT 1`)])
    ).rejects.toThrow(/DATABASE_URL_APP/);
  });

  it("el mensaje explica por qué no hay respaldo", async () => {
    // No alcanza con que rompa: el que se lo encuentre a las 3 de la mañana
    // tiene que entender por qué, o va a "arreglarlo" agregando el respaldo.
    const error = await enTenant(CTX, (db) => db.execute(sql`SELECT 1`)).catch(
      (e: Error) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no llevan filtro por inquilino/);
    expect((error as Error).message).toMatch(/todos los inquilinos/);
  });
});
