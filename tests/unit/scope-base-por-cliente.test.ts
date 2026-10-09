/**
 * La capa de datos elige la base: una por inquilino, y control para lo que no lo es.
 *
 * Con `BASE_POR_CLIENTE=1` cada aseguradora vive en `t_<hex>`, y la base se saca
 * del id dentro de `cliente()`, sin consulta extra. Con la bandera apagada hay una
 * sola cadena y todo sigue como antes: ese es el contrato que más pesa, porque
 * en dev, QA y staging la bandera queda apagada para siempre.
 *
 * El driver y drizzle se reemplazan por registros: lo que se mira es a qué cadena
 * va cada lote, cuántos clientes nacen y cuántas veces se pregunta por el rol.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { CENTINELA, nombreDeBase } from "@/data/bases";
import type { ClienteDatos } from "@/data/scope";

const mundo = vi.hoisted(() => ({
  /** Cada `neon(cadena)`: un cliente que nace. */
  nacidos: [] as string[],
  /** Cada lote que llegó al driver, con la cadena del cliente que lo mandó. */
  lotes: [] as Array<{ cadena: string; contexto: string[] }>,
  /** Cada vez que se preguntó por el rol, con la cadena del cliente que preguntó. */
  guardias: [] as string[],
  /** El rol de turno. */
  rol: { usuario: "claimmix_app", saltea: false, es_super: false },
  /** Si devuelve algo, el lote de esa cadena se rechaza con eso. */
  falla: null as null | ((cadena: string) => unknown),
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: (cadena: string) => {
    mundo.nacidos.push(cadena);
    return { cadena };
  },
}));

vi.mock("drizzle-orm/neon-http", () => ({
  drizzle: (driver: { cadena: string }) => ({
    execute: (q: unknown) => {
      if (JSON.stringify(q).includes("rolbypassrls")) {
        mundo.guardias.push(driver.cadena);
        return Promise.resolve([{ ...mundo.rol }]);
      }
      return { tipo: "consulta", q, _prepare: () => ({}) };
    },
    batch: (sentencias: Array<{ q: unknown }>) => {
      const error = mundo.falla?.(driver.cadena);
      if (error) return Promise.reject(error);
      // Lo que va antes de la consulta de verdad son las de contexto.
      mundo.lotes.push({
        cadena: driver.cadena,
        contexto: sentencias.filter((s) => JSON.stringify(s.q).includes("set_config")).map((s) => JSON.stringify(s.q)),
      });
      return Promise.resolve(sentencias.map((_, i) => ({ posicion: i })));
    },
  }),
}));

const HOST = "ep-test-pooler.example.com";
const APP = `postgresql://claimmix_app:fake-pass@${HOST}/neondb?sslmode=require`;
const TENANT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const CTX_A = { tenantId: TENANT_A };
const CTX_B = { tenantId: TENANT_B };

const cadenaDe = (tenantId: string) => APP.replace("/neondb", `/${nombreDeBase(tenantId)}`);
const consulta = (db: ClienteDatos) => db.execute(sql`SELECT 1`) as never;

let guardada: string | undefined;

beforeEach(() => {
  guardada = process.env.DATABASE_URL_APP;
  process.env.DATABASE_URL_APP = APP;
  mundo.nacidos.length = 0;
  mundo.lotes.length = 0;
  mundo.guardias.length = 0;
  mundo.rol = { usuario: "claimmix_app", saltea: false, es_super: false };
  mundo.falla = null;
  // El estado de la capa —clientes y roles comprobados— vive en el módulo.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (guardada === undefined) delete process.env.DATABASE_URL_APP;
  else process.env.DATABASE_URL_APP = guardada;
});

describe("con la bandera apagada: una sola cadena, como hoy", () => {
  it("cualquier inquilino, el centinela y enControl van a la misma", async () => {
    const { enTenant, enTenantVarias, enControl } = await import("@/data/scope");

    await enTenant(CTX_A, consulta);
    await enTenant(CTX_B, consulta);
    await enTenant({ tenantId: CENTINELA }, consulta);
    await enTenantVarias(CTX_A, (db) => [consulta(db)]);
    await enControl(CTX_A, consulta);

    expect(new Set(mundo.lotes.map((l) => l.cadena))).toEqual(new Set([APP]));
    expect(mundo.lotes).toHaveLength(5);
    expect(mundo.nacidos).toEqual([APP]);
    expect(mundo.guardias).toEqual([APP]);
  });

  it("un id que no es uuid no frena nada: igual que antes de las bases", async () => {
    const { enTenant } = await import("@/data/scope");

    await expect(enTenant({ tenantId: "no-es-un-uuid" }, consulta)).resolves.toBeDefined();
    expect(mundo.lotes.map((l) => l.cadena)).toEqual([APP]);
  });

  it("el contexto sigue siendo el del inquilino", async () => {
    const { enTenant } = await import("@/data/scope");

    await enTenant(CTX_A, consulta);

    expect(mundo.lotes[0].contexto).toHaveLength(1);
    expect(mundo.lotes[0].contexto[0]).toContain("claimmix.tenant_id");
    expect(mundo.lotes[0].contexto[0]).toContain(TENANT_A);
  });

  it("una cadena con espacios y salto de línea se usa recortada", async () => {
    process.env.DATABASE_URL_APP = `  ${APP}\n`;
    const { enTenant } = await import("@/data/scope");

    await enTenant(CTX_A, consulta);

    expect(mundo.nacidos).toEqual([APP]);
  });
});

describe("con BASE_POR_CLIENTE=1", () => {
  beforeEach(() => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
  });

  it("cada inquilino va a su base t_<hex>, con el resto de la cadena igual", async () => {
    const { enTenant } = await import("@/data/scope");

    await enTenant(CTX_A, consulta);
    await enTenant(CTX_B, consulta);

    expect(mundo.lotes.map((l) => l.cadena)).toEqual([cadenaDe(TENANT_A), cadenaDe(TENANT_B)]);
    expect(mundo.lotes[0].cadena).toMatch(/\/t_[0-9a-f]{32}\?sslmode=require$/);
    expect(mundo.lotes[0].cadena).not.toBe(mundo.lotes[1].cadena);
  });

  it("el centinela va a control", async () => {
    const { enTenant } = await import("@/data/scope");

    await enTenant({ tenantId: CENTINELA }, consulta);

    expect(mundo.lotes.map((l) => l.cadena)).toEqual([APP]);
  });

  it("enTenantVarias y enTenantDeUsuarioVarias van a la base del inquilino", async () => {
    const { enTenantVarias, enTenantDeUsuarioVarias } = await import("@/data/scope");

    await enTenantVarias(CTX_A, (db) => [consulta(db), consulta(db)]);
    await enTenantDeUsuarioVarias({ tenantId: TENANT_B, userId: "usuario-b" }, (db) => [consulta(db)]);

    expect(mundo.lotes.map((l) => l.cadena)).toEqual([cadenaDe(TENANT_A), cadenaDe(TENANT_B)]);
    // La de usuario lleva dos sentencias de contexto: el inquilino y la persona.
    expect(mundo.lotes[1].contexto).toHaveLength(2);
    expect(mundo.lotes[1].contexto[0]).toContain(TENANT_B);
    expect(mundo.lotes[1].contexto[1]).toContain("claimmix.user_id");
  });

  it("el mismo inquilino reusa su cliente", async () => {
    const { enTenant } = await import("@/data/scope");

    await enTenant(CTX_A, consulta);
    await enTenant(CTX_A, consulta);
    await enTenant(CTX_A, consulta);

    expect(mundo.nacidos).toEqual([cadenaDe(TENANT_A)]);
  });

  describe("enControl y enControlVarias", () => {
    it("van siempre a control, con el inquilino del contexto puesto", async () => {
      const { enControl } = await import("@/data/scope");

      await enControl(CTX_A, consulta);
      await enControl(CTX_B, consulta);

      expect(mundo.lotes.map((l) => l.cadena)).toEqual([APP, APP]);
      // El set_config lleva el inquilino y no el centinela: la RLS de control lo necesita.
      expect(mundo.lotes[0].contexto).toHaveLength(1);
      expect(mundo.lotes[0].contexto[0]).toContain("claimmix.tenant_id");
      expect(mundo.lotes[0].contexto[0]).toContain(TENANT_A);
      expect(mundo.lotes[1].contexto[0]).toContain(TENANT_B);
      expect(mundo.nacidos).toEqual([APP]);
    });

    it("la versión con varias consultas también", async () => {
      const { enControlVarias } = await import("@/data/scope");

      const [a, b] = await enControlVarias(CTX_A, (db) => [consulta(db), consulta(db)]);

      expect(mundo.lotes.map((l) => l.cadena)).toEqual([APP]);
      expect(mundo.lotes[0].contexto[0]).toContain(TENANT_A);
      // El contexto no vuelve: lo que devuelve son las dos consultas, en orden.
      expect([a, b]).toEqual([{ posicion: 1 }, { posicion: 2 }]);
    });

    it("mezcladas con enTenant, cada una a la suya", async () => {
      const { enTenant, enControl } = await import("@/data/scope");

      await enTenant(CTX_A, consulta);
      await enControl(CTX_A, consulta);
      await enTenant(CTX_A, consulta);

      expect(mundo.lotes.map((l) => l.cadena)).toEqual([cadenaDe(TENANT_A), APP, cadenaDe(TENANT_A)]);
    });

    it("comparten las guardas de la capa: rechazan una promesa", async () => {
      const { enControl } = await import("@/data/scope");

      await expect(enControl(CTX_A, (() => Promise.resolve([])) as never)).rejects.toThrow(
        /promesa, no una consulta/
      );
      expect(mundo.lotes).toHaveLength(0);
    });
  });

  describe("el rol se comprueba una vez por host y usuario, no por base", () => {
    it("varias bases del mismo host, una sola pregunta", async () => {
      const { enTenant, enControl } = await import("@/data/scope");

      await enTenant(CTX_A, consulta);
      await enTenant(CTX_B, consulta);
      await enControl(CTX_A, consulta);
      await enTenant({ tenantId: CENTINELA }, consulta);

      expect(mundo.guardias).toEqual([cadenaDe(TENANT_A)]);
    });

    it("dos pedidos juntos, en el primer uso, preguntan una sola vez", async () => {
      const { enTenant } = await import("@/data/scope");

      await Promise.all([enTenant(CTX_A, consulta), enTenant(CTX_B, consulta), enTenant(CTX_A, consulta)]);

      expect(mundo.guardias).toHaveLength(1);
      expect(mundo.lotes).toHaveLength(3);
    });

    it("otro host vuelve a preguntar", async () => {
      const { enTenant } = await import("@/data/scope");

      await enTenant(CTX_A, consulta);
      process.env.DATABASE_URL_APP = APP.replace(HOST, "otro-host.example.com");
      await enTenant(CTX_A, consulta);

      expect(mundo.guardias).toHaveLength(2);
    });

    it("otro usuario del mismo host también", async () => {
      const { enTenant } = await import("@/data/scope");

      await enTenant(CTX_A, consulta);
      process.env.DATABASE_URL_APP = APP.replace("claimmix_app", "otro_rol");
      await enTenant(CTX_A, consulta);

      expect(mundo.guardias).toHaveLength(2);
    });

    it("un rol que saltea RLS rompe en todas las bases del host, no sólo en la primera", async () => {
      mundo.rol = { usuario: "neondb_owner", saltea: true, es_super: false };
      const { enTenant, enControl } = await import("@/data/scope");

      await expect(enTenant(CTX_A, consulta)).rejects.toThrow(/BYPASSRLS/);
      await expect(enTenant(CTX_B, consulta)).rejects.toThrow(/BYPASSRLS/);
      await expect(enControl(CTX_A, consulta)).rejects.toThrow(/BYPASSRLS/);
      expect(mundo.lotes).toHaveLength(0);
    });
  });

  describe("una base que no existe (3D000)", () => {
    const noExiste = () => Object.assign(new Error('database "t_x" does not exist'), { code: "3D000" });

    it("saca el cliente del mapa y vuelve a tirar el mismo error", async () => {
      const error = noExiste();
      mundo.falla = (cadena) => (cadena === cadenaDe(TENANT_A) ? error : null);
      const { enTenant } = await import("@/data/scope");

      await expect(enTenant(CTX_A, consulta)).rejects.toBe(error);
      expect(mundo.nacidos).toEqual([cadenaDe(TENANT_A)]);

      // Con la base ya creada, el próximo pedido arma un cliente nuevo.
      mundo.falla = null;
      await enTenant(CTX_A, consulta);
      expect(mundo.nacidos).toEqual([cadenaDe(TENANT_A), cadenaDe(TENANT_A)]);
      expect(mundo.lotes.map((l) => l.cadena)).toEqual([cadenaDe(TENANT_A)]);
    });

    it("también si drizzle lo deja en `cause`", async () => {
      const error = new Error("Failed query", { cause: noExiste() });
      mundo.falla = () => error;
      const { enTenantVarias } = await import("@/data/scope");

      await expect(enTenantVarias(CTX_A, (db) => [consulta(db)])).rejects.toBe(error);

      mundo.falla = null;
      await enTenantVarias(CTX_A, (db) => [consulta(db)]);
      expect(mundo.nacidos).toHaveLength(2);
    });

    it("las demás bases no se enteran", async () => {
      mundo.falla = (cadena) => (cadena === cadenaDe(TENANT_A) ? noExiste() : null);
      const { enTenant } = await import("@/data/scope");

      await enTenant(CTX_B, consulta);
      await expect(enTenant(CTX_A, consulta)).rejects.toThrow(/does not exist/);
      await enTenant(CTX_B, consulta);

      expect(mundo.nacidos).toEqual([cadenaDe(TENANT_B), cadenaDe(TENANT_A)]);
    });

    it("otro error no saca nada: el cliente se reusa", async () => {
      const error = Object.assign(new Error("connection terminated"), { code: "57P01" });
      mundo.falla = () => error;
      const { enTenant } = await import("@/data/scope");

      await expect(enTenant(CTX_A, consulta)).rejects.toBe(error);
      mundo.falla = null;
      await enTenant(CTX_A, consulta);

      expect(mundo.nacidos).toEqual([cadenaDe(TENANT_A)]);
    });
  });

  describe("el mapa de clientes tiene techo", () => {
    const idN = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

    it("pasadas las 500 bases se va la más vieja, y las demás quedan", async () => {
      const { enTenant } = await import("@/data/scope");

      for (let n = 1; n <= 501; n++) await enTenant({ tenantId: idN(n) }, consulta);
      expect(mundo.nacidos).toHaveLength(501);

      // La segunda sigue en el mapa; la primera se fue y nace de nuevo.
      await enTenant({ tenantId: idN(2) }, consulta);
      await enTenant({ tenantId: idN(501) }, consulta);
      expect(mundo.nacidos).toHaveLength(501);

      await enTenant({ tenantId: idN(1) }, consulta);
      expect(mundo.nacidos).toHaveLength(502);
      expect(mundo.nacidos.filter((c) => c === cadenaDe(idN(1)))).toHaveLength(2);
    });

    it("500 justas caben todas", async () => {
      const { enTenant } = await import("@/data/scope");

      for (let n = 1; n <= 500; n++) await enTenant({ tenantId: idN(n) }, consulta);
      for (let n = 1; n <= 500; n++) await enTenant({ tenantId: idN(n) }, consulta);

      expect(mundo.nacidos).toHaveLength(500);
    });
  });

  it("un id que no es uuid tira antes de tocar la red", async () => {
    const { enTenant, enTenantVarias, enTenantDeUsuarioVarias } = await import("@/data/scope");
    const raro = { tenantId: 'x"; DROP DATABASE neondb; --' };

    await expect(enTenant(raro, consulta)).rejects.toThrow(/no es un uuid/);
    await expect(enTenantVarias(raro, (db) => [consulta(db)])).rejects.toThrow(/no es un uuid/);
    await expect(
      enTenantDeUsuarioVarias({ ...raro, userId: "u" }, (db) => [consulta(db)])
    ).rejects.toThrow(/no es un uuid/);

    expect(mundo.nacidos).toHaveLength(0);
    expect(mundo.guardias).toHaveLength(0);
    expect(mundo.lotes).toHaveLength(0);
  });

  it("enControl con un id raro sí corre: la base no sale de él, el contexto sí", async () => {
    const { enControl } = await import("@/data/scope");

    await enControl({ tenantId: "no-es-un-uuid" }, consulta);

    expect(mundo.lotes.map((l) => l.cadena)).toEqual([APP]);
  });

  it("sin DATABASE_URL_APP rompe, con la bandera prendida también", async () => {
    delete process.env.DATABASE_URL_APP;
    process.env.DATABASE_URL = `postgresql://duenio:fake-pass@${HOST}/neondb`;
    const { enTenant, enControl } = await import("@/data/scope");

    try {
      await expect(enTenant(CTX_A, consulta)).rejects.toThrow(/DATABASE_URL_APP/);
      await expect(enControl(CTX_A, consulta)).rejects.toThrow(/DATABASE_URL_APP/);
      expect(mundo.nacidos).toHaveLength(0);
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});
