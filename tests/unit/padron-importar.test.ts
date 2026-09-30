/**
 * Importación del padrón (B16). Se compila con drizzle de verdad (pg-proxy) para
 * leer el SQL: los upserts, que la auditoría viaje en el mismo lote que los
 * datos, que el conteo de pólizas sea el que la base escribió, y que con un solo
 * error no se escriba nada.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[]; lote: number }[],
  lotes: [] as string[],
  clientes: [] as unknown[][],
  polizas: [] as unknown[][],
  /** Lo que la base contaría en la fila de auditoría: las pólizas que el upsert escribió. */
  escritas: { altas: 0, cambios: 0 },
  /** Un código de Postgres con el que fallan las escrituras. */
  falla: undefined as string | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    m.consultas.push({ sql, params, lote: m.lotes.length });
    if (/^select .* from "customers"/.test(sql)) return { rows: m.clientes };
    if (/^select .* from "policies"/.test(sql)) return { rows: m.polizas };
    if (m.falla && /^(insert|with) /.test(sql)) throw Object.assign(new Error("falla"), { code: m.falla });
    if (/insert into "audit_log"/.test(sql)) {
      const clientes = params.find((p) => typeof p === "string" && p.startsWith("{"));
      return { rows: [[{ ...JSON.parse(clientes as string), polizas: m.escritas }]] };
    }
    return { rows: [] };
  });
  return {
    enTenantVarias: (ctx: { tenantId: string }, armar: (d: unknown) => PromiseLike<unknown>[]) => {
      m.lotes.push(ctx.tenantId);
      return Promise.all(armar(db));
    },
  };
});

import { AuditEvent } from "@/lib/audit/log";
import { MAX_ERRORES_A_MOSTRAR, procesarPadron } from "@/server/padron/importar";

const TENANT = "10000000-0000-0000-0000-000000000001";
const QUIEN = { tenantId: TENANT, userId: "user-1", ip: "203.0.113.7", ua: "vitest" };

const ANA_EN_LA_BASE = ["c-ana", "30123456", "Ana Pérez", "ana@x.com", null, null, null];
const POLIZA_EN_LA_BASE = ["p-1", "c-ana", "POL-1", "auto", "active", "2025-01-01", "2025-12-31", "1000.00"];

// La auditoría y las pólizas van en una sola sentencia (`with … insert into "audit_log"`), por eso el `with`.
const escrituras = () => m.consultas.filter((c) => /^(insert|with) /.test(c.sql));
const resultado = async (csv: string, aplicar: boolean) => {
  const r = await procesarPadron(QUIEN, csv, aplicar);
  if (!r.ok) throw new Error(r.error);
  return r.resultado;
};

beforeEach(() => {
  m.consultas.length = 0;
  m.lotes.length = 0;
  m.clientes = [];
  m.polizas = [];
  m.escritas = { altas: 0, cambios: 0 };
  m.falla = undefined;
});

describe("procesarPadron: vista previa", () => {
  it("lee lo que hay en UN viaje y no escribe nada", async () => {
    const r = await resultado("dni,nombre,poliza\n30123456,Ana Pérez,POL-1", false);

    expect(r.aplicado).toBe(false);
    expect(r.resumen.clientes.altas).toBe(1);
    expect(r.resumen.polizas.altas).toBe(1);
    expect(m.lotes).toEqual([TENANT]);
    expect(m.consultas).toHaveLength(2);
    expect(escrituras()).toHaveLength(0);
  });

  it("una fila sin DNI en la base no se toma por coincidencia", async () => {
    m.clientes = [["c-x", null, "Sin DNI", null, null, null, null]];
    const r = await resultado("dni,nombre\n30123456,Ana Pérez", false);
    expect(r.resumen.clientes).toEqual({ altas: 1, cambios: 0, iguales: 0 });
  });
});

describe("procesarPadron: importación", () => {
  it("escribe clientes, pólizas y auditoría en el MISMO lote, con ON CONFLICT", async () => {
    const r = await resultado("dni,nombre,poliza,ramo\n30123456,Ana Pérez,pol-1,auto", true);

    expect(r.aplicado).toBe(true);
    expect(m.lotes).toEqual([TENANT, TENANT]);
    const escritas = escrituras();
    expect(escritas.map((c) => c.lote)).toEqual([2, 2]);

    // Las pólizas y su auditoría son una sola sentencia: la auditoría cuenta lo que el upsert escribió.
    const [clientes, polizas] = escritas as [(typeof escritas)[number], (typeof escritas)[number]];
    expect(clientes.sql).toMatch(/^insert into "customers"/);
    expect(clientes.sql).toMatch(/on conflict \("tenant_id","dni"\) where dni is not null do update set/);
    expect(polizas.sql).toMatch(/^with "escritas" as \(insert into "policies"/);
    expect(polizas.sql).toMatch(/on conflict \("tenant_id","policy_number"\) do update set/);
    expect(polizas.sql).toMatch(/where "policies"\."customer_id" = excluded\.customer_id/);
    expect(polizas.sql).toMatch(/returning \(xmax = 0\) as "alta"\) insert into "audit_log"/);

    // El inquilino sale de la sesión y la póliza apunta al cliente del mismo archivo.
    expect(clientes.params).toContain(TENANT);
    expect(polizas.params).toContain(TENANT);
    expect(polizas.params).toContain("POL-1");
    const idDelCliente = clientes.params.find((p) => typeof p === "string" && /^[0-9a-f-]{36}$/.test(p) && p !== TENANT);
    expect(idDelCliente).toBeDefined();
    expect(polizas.params).toContain(idDelCliente);
  });

  it("la auditoría lleva el evento, el autor y la IP, y sólo cuántos: nunca DNI ni números de póliza", async () => {
    await resultado("dni,nombre,poliza\n30123456,Ana Pérez,POL-1", true);
    const auditoria = escrituras().at(-1)!;

    expect(auditoria.params).toContain(AuditEvent.PADRON_IMPORTADO);
    expect(auditoria.params).toContain("user-1");
    expect(auditoria.params).toContain("203.0.113.7");
    // El conteo de pólizas lo arma la base con lo que el upsert escribió; el de clientes viaja como parámetro.
    const payload = auditoria.params.find((p) => typeof p === "string" && p.startsWith("{")) as string;
    expect(payload).toBe(JSON.stringify({ clientes: { altas: 1, cambios: 0 } }));
    expect(auditoria.sql).toMatch(/jsonb_build_object\('polizas', jsonb_build_object\('altas', \(\(select count\(\*\) from "escritas" where "alta"\)\)::int/);
    expect(payload).not.toContain("30123456");
    expect(payload).not.toContain("POL-1");
    expect(payload).not.toContain("Ana");
  });

  it("el conteo de pólizas es el que la base escribió, no el del plan: el `setWhere` puede saltear una", async () => {
    m.escritas = { altas: 1, cambios: 0 };
    const r = await resultado("dni,nombre,poliza\n30123456,Ana Pérez,POL-1\n30123456,,POL-2", true);

    expect(r.aplicado).toBe(true);
    expect(r.resumen.polizas).toEqual({ altas: 1, cambios: 0, iguales: 0 });
  });

  it("sin pólizas que escribir la auditoría es un insert solo, con el conteo en cero", async () => {
    await resultado("dni,nombre\n30123456,Ana Pérez", true);
    const [clientes, auditoria] = escrituras() as [(typeof m.consultas)[number], (typeof m.consultas)[number]];

    expect(clientes.sql).toMatch(/^insert into "customers"/);
    expect(auditoria.sql).toMatch(/^insert into "audit_log"/);
    expect(auditoria.sql).not.toMatch(/"policies"/);
  });

  it("de un cliente que ya existe manda sólo lo que el archivo cambia y el ON CONFLICT conserva el resto", async () => {
    m.clientes = [ANA_EN_LA_BASE];
    await resultado("dni,telefono\n30123456,291 642-6930", true);
    const [clientes] = escrituras();

    // El email que se leyó no viaja: si alguien lo cambió a mano en el medio, esa edición se queda.
    expect(clientes!.params).not.toContain("ana@x.com");
    expect(clientes!.params).toContain("c-ana");
    expect(clientes!.sql).toMatch(/"email" = coalesce\(excluded\.email, "customers"\."email"\)/);
    expect(clientes!.sql).toMatch(/"phone" = coalesce\(excluded\.phone, "customers"\."phone"\)/);
    expect(clientes!.sql).toMatch(/"birth_date" = coalesce\(excluded\.birth_date, "customers"\."birth_date"\)/);
    expect(clientes!.sql).toMatch(/"address" = coalesce\(excluded\.address, "customers"\."address"\)/);
  });

  it.each(["23503", "23505"])("si otra importación se cruza (%s) contesta un rechazo y no una caída", async (codigo) => {
    m.falla = codigo;
    expect(await procesarPadron(QUIEN, "dni,nombre,poliza\n30123456,Ana Pérez,POL-1", true)).toEqual({
      ok: false,
      error: "cruce_de_importaciones",
    });
  });

  it("un error de la base que no es un cruce sigue siendo una caída", async () => {
    m.falla = "53300";
    await expect(procesarPadron(QUIEN, "dni,nombre\n30123456,Ana Pérez", true)).rejects.toMatchObject({ cause: { code: "53300" } });
  });

  it("un cliente que ya existe conserva su id y la póliza nueva se le cuelga", async () => {
    m.clientes = [ANA_EN_LA_BASE];
    m.escritas = { altas: 1, cambios: 0 };
    const r = await resultado("dni,telefono,poliza\n30123456,291 642-6930,POL-2", true);

    expect(r.resumen).toEqual({
      clientes: { altas: 0, cambios: 1, iguales: 0 },
      polizas: { altas: 1, cambios: 0, iguales: 0 },
    });
    const [clientes, polizas] = escrituras();
    expect(clientes!.params).toContain("c-ana");
    expect(polizas!.params).toContain("c-ana");
  });

  it("un archivo que no trae nada nuevo no abre un lote de escritura", async () => {
    m.clientes = [ANA_EN_LA_BASE];
    m.polizas = [POLIZA_EN_LA_BASE];
    const r = await resultado("dni,nombre,poliza,ramo\n30123456,Ana Pérez,POL-1,auto", true);

    expect(r.aplicado).toBe(false);
    expect(r.resumen.clientes.iguales).toBe(1);
    expect(m.lotes).toHaveLength(1);
    expect(escrituras()).toHaveLength(0);
  });

  it("reconoce lo guardado con otra forma de escribirlo: la búsqueda compara normalizado y el ON CONFLICT ve el texto guardado", async () => {
    m.clientes = [["c-ana", "30.123.456", "Ana Pérez", "ana@x.com", null, null, null]];
    m.polizas = [["p-1", "c-ana", "pol-8812-r", "auto", "active", "2025-01-01", "2025-12-31", "1000.00"]];
    m.escritas = { altas: 0, cambios: 1 };
    const r = await resultado("dni,telefono,poliza,ramo\n30123456,291 642-6930,POL-8812-R,home", true);

    // Ni un cliente ni una póliza nuevos: eran los mismos, escritos de otra manera.
    expect(r.resumen).toEqual({
      clientes: { altas: 0, cambios: 1, iguales: 0 },
      polizas: { altas: 0, cambios: 1, iguales: 0 },
    });
    const [lecturaClientes, lecturaPolizas] = m.consultas as [(typeof m.consultas)[number], (typeof m.consultas)[number]];
    expect(lecturaClientes.sql).toMatch(/regexp_replace\(coalesce\("customers"\."dni", ''\), '\[\^0-9\]', '', 'g'\) in \(\$\d+\)/);
    expect(lecturaPolizas.sql).toMatch(/upper\(replace\("policies"\."policy_number", ' ', ''\)\) in \(\$\d+\)/);
    expect(lecturaClientes.params).toContain("30123456");
    expect(lecturaPolizas.params).toContain("POL-8812-R");

    // Se escribe con el texto guardado, para que el ON CONFLICT caiga sobre la fila que ya está.
    const [clientes, polizas] = escrituras();
    expect(clientes!.params).toContain("30.123.456");
    expect(clientes!.params).not.toContain("30123456");
    expect(clientes!.params).toContain("c-ana");
    expect(polizas!.params).toContain("pol-8812-r");
    expect(polizas!.params).not.toContain("POL-8812-R");
  });

  it("una póliza guardada con otra forma de escribirla y de otro titular se rechaza en vez de duplicarse", async () => {
    m.clientes = [ANA_EN_LA_BASE];
    m.polizas = [["p-1", "c-otro", "pol 8812-r", "auto", "active", null, null, null]];
    const r = await resultado("dni,nombre,poliza\n30123456,Ana Pérez,POL 8812-R", true);

    expect(r.errores).toEqual([{ fila: 2, codigo: "poliza_de_otro_titular" }]);
    expect(r.aplicado).toBe(false);
    expect(escrituras()).toHaveLength(0);
  });

  it("con UN solo error no se escribe ninguna fila, ni las buenas", async () => {
    const r = await resultado("dni,nombre\n30123456,Ana Pérez\n123,Luis Gómez", true);

    expect(r.aplicado).toBe(false);
    expect(r.erroresTotal).toBe(1);
    expect(r.errores).toEqual([{ fila: 3, codigo: "dni_invalido" }]);
    expect(m.lotes).toHaveLength(1);
    expect(escrituras()).toHaveLength(0);
  });

  it("los errores de lectura y los del plan salen juntos y en orden de fila", async () => {
    m.clientes = [ANA_EN_LA_BASE];
    m.polizas = [POLIZA_EN_LA_BASE];
    const r = await resultado(
      ["dni,nombre,poliza", "40123456,Luis Gómez,POL-1", "1,Marta Díaz,", "50123456,,"].join("\n"),
      true
    );
    expect(r.errores).toEqual([
      { fila: 2, codigo: "poliza_de_otro_titular" },
      { fila: 3, codigo: "dni_invalido" },
      { fila: 4, codigo: "nombre_requerido" },
    ]);
    expect(escrituras()).toHaveLength(0);
  });

  it("devuelve como mucho MAX_ERRORES_A_MOSTRAR errores y cuenta el total", async () => {
    const malas = Array.from({ length: MAX_ERRORES_A_MOSTRAR + 10 }, () => "1,Ana Pérez").join("\n");
    const r = await resultado(`dni,nombre\n${malas}`, false);
    expect(r.errores).toHaveLength(MAX_ERRORES_A_MOSTRAR);
    expect(r.erroresTotal).toBe(MAX_ERRORES_A_MOSTRAR + 10);
  });

  it("informa las columnas que no reconoció", async () => {
    const r = await resultado("dni,nombre,color\n30123456,Ana Pérez,azul", false);
    expect(r.ignoradas).toEqual(["color"]);
  });
});

describe("procesarPadron: archivo", () => {
  it.each([
    ["vacío", "", "archivo_vacio"],
    ["sin columna dni", "nombre\nAna", "falta_columna_dni"],
    ["con una comilla sin cerrar", 'dni\n"1', "comilla_sin_cerrar"],
  ])("un archivo %s se rechaza sin tocar la base", async (_caso, csv, error) => {
    expect(await procesarPadron(QUIEN, csv, true)).toEqual({ ok: false, error });
    expect(m.consultas).toHaveLength(0);
    expect(m.lotes).toHaveLength(0);
  });
});
