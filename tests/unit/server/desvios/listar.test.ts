/**
 * La lista de desvíos (B22): del más nuevo al más viejo, paginada en un solo
 * viaje, con el titular tapado para quien no puede ver el padrón y el dato de
 * cada desvío validado antes de mostrarse.
 *
 * Las consultas se arman con un cliente drizzle de verdad —que no se conecta
 * hasta ejecutar— para poder leer su SQL; lo que devuelven es de mentira.
 */

vi.mock("server-only", () => ({}));

const { enTenantVarias } = vi.hoisted(() => ({ enTenantVarias: vi.fn() }));
vi.mock("@/data/scope", () => ({ enTenantVarias }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/db/schema";
import { getT } from "@/lib/i18n";
import { OCULTO } from "@/server/cases/pii";
import { etiquetaDeDocumento, listarDesvios } from "@/server/desvios/listar";

const CTX = { tenantId: "tenant-1" };
const tEs = getT("es-AR");
const tEn = getT("en-US");
const cliente = drizzle(neon("postgres://u:p@h/db"), { schema });

type Sql = { sql: string; params: unknown[] };
type Fila = {
  case_id: string;
  titular: string | null;
  tipo: string | null;
  regla: string;
  ancla: string;
  detectado_en: string;
  dato: string | null;
};
let armadas: Sql[] = [];

function responder(filas: Fila[], total = filas.length) {
  enTenantVarias.mockImplementation(async (_ctx, armar: (db: unknown) => Array<{ toSQL(): Sql }>) => {
    armadas = armar(cliente).map((q) => q.toSQL());
    return [[{ n: total }], filas];
  });
}

const fila = (extra: Partial<Fila> = {}): Fila => ({
  case_id: "0a1b2c3d-0000-4000-8000-000000000001",
  titular: "Ana Pérez",
  tipo: "choque",
  regla: "plazo_vencido",
  ancla: "2026-09-29T15:00:00+00:00",
  detectado_en: "2026-09-30T03:00:00+00:00",
  dato: "art56",
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  armadas = [];
});

describe("listarDesvios", () => {
  it("va una sola vez a la base, con el conteo y la página en el mismo lote", async () => {
    responder([]);

    await listarDesvios(CTX, "owner");

    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    expect(enTenantVarias.mock.calls[0]![0]).toBe(CTX);
    expect(armadas).toHaveLength(2);
    expect(armadas[0]!.sql).toMatch(/^select count\(\*\)::int from "case_desvios"/);
  });

  it("del más nuevo al más viejo, con un orden total para que las páginas no se pisen", async () => {
    responder([]);
    await listarDesvios(CTX, "owner");

    expect(armadas[1]!.sql).toMatch(
      /order by "case_desvios"\."detectado_en" desc, "case_desvios"\."ancla" desc, "case_desvios"\."case_id", "case_desvios"\."regla" limit \$\d+( offset \$\d+)?$/
    );
  });

  it("une con el caso para traer el titular, y no filtra por inquilino a mano: eso lo pone la base", async () => {
    responder([]);
    await listarDesvios(CTX, "owner");

    expect(armadas[1]!.sql).toContain(`inner join "cases" on "cases"."id" = "case_desvios"."case_id"`);
    for (const q of armadas) expect(q.sql).not.toMatch(/where/);
  });

  it("trae el tipo de reclamo del caso en la misma consulta, para nombrar bien los documentos", async () => {
    responder([]);
    await listarDesvios(CTX, "owner");

    expect(armadas[1]!.sql).toContain(`"cases"."claim_type"`);
  });

  it("pagina: la segunda página salta la primera", async () => {
    responder([]);
    await listarDesvios(CTX, "owner", { page: 3, per_page: 10 });

    expect(armadas[1]!.params.slice(-2)).toEqual([10, 20]);
  });

  it("sin desvíos, la lista queda vacía", async () => {
    responder([]);
    expect(await listarDesvios(CTX, "owner")).toEqual({
      data: [],
      meta: { total: 0, page: 1, per_page: 25, pages: 0 },
    });
  });

  it("devuelve el caso al que apunta cada desvío, con su número y las fechas en ISO", async () => {
    responder([fila()], 41);

    const r = await listarDesvios(CTX, "owner");

    expect(r.meta).toEqual({ total: 41, page: 1, per_page: 25, pages: 2 });
    expect(r.data).toEqual([
      {
        caseId: "0a1b2c3d-0000-4000-8000-000000000001",
        numero: expect.any(String),
        titular: "Ana Pérez",
        tipo: "choque",
        regla: "plazo_vencido",
        ancla: "2026-09-29T15:00:00.000Z",
        detectadoEn: "2026-09-30T03:00:00.000Z",
        datos: ["art56"],
      },
    ]);
    expect(r.data[0]!.numero).not.toContain("0a1b2c3d-0000-4000");
  });

  it("tapa el titular con OCULTO a quien no puede ver el padrón, y deja el vacío como vacío", async () => {
    responder([fila(), fila({ titular: null })]);

    const r = await listarDesvios(CTX, "analyst");

    expect(r.data.map((d) => d.titular)).toEqual([OCULTO, null]);
  });

  it.each(["owner", "admin", "specialist"])("%s ve el titular", async (rol) => {
    responder([fila()]);
    expect((await listarDesvios(CTX, rol)).data[0]!.titular).toBe("Ana Pérez");
  });

  it("descarta del dato lo que no tiene forma de clave", async () => {
    responder([fila({ dato: "fotos_danos,<img src=x onerror=alert(1)>,denuncia_policial" })]);

    expect((await listarDesvios(CTX, "owner")).data[0]!.datos).toEqual(["fotos_danos", "denuncia_policial"]);
  });

  it("un desvío sin dato queda sin claves", async () => {
    responder([fila({ regla: "derivacion_sin_respuesta", dato: null })]);
    expect((await listarDesvios(CTX, "owner")).data[0]!.datos).toEqual([]);
  });

  it("una regla que ya no existe llega tal cual: la pantalla decide cómo mostrarla", async () => {
    responder([fila({ regla: "regla_vieja" })]);
    expect((await listarDesvios(CTX, "owner")).data[0]!.regla).toBe("regla_vieja");
  });

  it("una página que no se entiende no es un pedido válido: falla en vez de ir a la base", async () => {
    responder([]);
    await expect(listarDesvios(CTX, "owner", { page: 0 })).rejects.toThrow();
    expect(enTenantVarias).not.toHaveBeenCalled();
  });
});

describe("etiquetaDeDocumento", () => {
  it("usa la etiqueta de la configuración de documentos", () => {
    expect(etiquetaDeDocumento("parte_amistoso", "choque", "es-AR", tEs)).toBe("Parte amistoso de accidente");
    expect(etiquetaDeDocumento("certificado_medico", "accidente_personal", "es-AR", tEs)).toBe(
      "Certificado médico / alta hospitalaria"
    );
  });

  it("la misma clave se llama distinto según el tipo de reclamo del caso", () => {
    expect(etiquetaDeDocumento("fotos_danos", "choque", "es-AR", tEs)).toBe("Fotos de los daños");
    expect(etiquetaDeDocumento("fotos_danos", "granizo", "es-AR", tEs)).toBe("Fotos de los daños por granizo");
    expect(etiquetaDeDocumento("fotos_danos", "cristales", "es-AR", tEs)).toBe("Fotos del vidrio dañado");
    expect(etiquetaDeDocumento("fotos_danos", "robo_contenido", "es-AR", tEs)).toBe("Fotos del interior del vehículo");
  });

  it("una clave que no está en la configuración de ese tipo se dice con espacios", () => {
    expect(etiquetaDeDocumento("otro_documento_raro", "choque", "es-AR", tEs)).toBe("otro documento raro");
    expect(etiquetaDeDocumento("parte_amistoso", "robo", "es-AR", tEs)).toBe("parte amistoso");
  });

  it("un caso sin tipo, o con uno que ya no existe, no rompe: dice la clave con espacios", () => {
    expect(etiquetaDeDocumento("fotos_danos", null, "es-AR", tEs)).toBe("fotos danos");
    expect(etiquetaDeDocumento("fotos_danos", "tipo_viejo", "es-AR", tEs)).toBe("fotos danos");
    expect(etiquetaDeDocumento("fotos_danos", "constructor", "es-AR", tEs)).toBe("fotos danos");
  });

  it("en inglés se dice como en la pantalla del caso, con el diccionario y sin el castellano de la configuración", () => {
    expect(etiquetaDeDocumento("fotos_danos", "choque", "en-US", tEn)).toBe("Damage photos");
    expect(etiquetaDeDocumento("fotos_danos", "granizo", "en-US", tEn)).toBe("Damage photos");
    expect(etiquetaDeDocumento("parte_amistoso", "choque", "en-US", tEn)).toBe("Friendly accident report");
    expect(etiquetaDeDocumento("parte_amistoso", null, "en-US", tEn)).toBe("Friendly accident report");
  });
});
