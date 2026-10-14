/**
 * POST /api/padron/vista-previa y /api/padron/importar (B16): el borde HTTP.
 * Quién entra, qué archivos se rechazan y con qué frase, y que el inquilino sale
 * de la sesión. `procesarPadron` se prueba aparte (padron-importar.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const m = vi.hoisted(() => ({
  entrar: vi.fn(),
  procesar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: m.entrar }));
vi.mock("@/server/padron/importar", () => ({ procesarPadron: m.procesar }));
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: async () => "es-AR" }));
vi.mock("@/lib/rate-limit/index", () => ({
  getClientIp: () => "203.0.113.7",
  RATE_LIMIT_CONFIGS: { PADRON_IMPORTAR: { limit: 30, windowMs: 3_600_000 } },
}));

import { POST as importar } from "@/app/api/padron/importar/route";
import { POST as vistaPrevia } from "@/app/api/padron/vista-previa/route";
import { MAX_BYTES_DEL_ARCHIVO } from "@/core/padron/csv";

const TENANT = "10000000-0000-0000-0000-000000000001";
const USER = "20000000-0000-0000-0000-000000000001";
const ROLES_QUE_ENTRAN = ["owner", "admin", "specialist"];

const sesion = { rol: "admin", permitido: true };

const RESULTADO = {
  resumen: {
    clientes: { altas: 1, cambios: 0, iguales: 0 },
    polizas: { altas: 0, cambios: 0, iguales: 0 },
  },
  errores: [],
  erroresTotal: 0,
  ignoradas: [],
  aplicado: false,
};

function pedido(ruta: "importar" | "vista-previa", archivos: (File | string)[], extra: Record<string, string> = {}) {
  const form = new FormData();
  for (const a of archivos) form.append("archivo", a);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new NextRequest(`http://localhost/api/padron/${ruta}`, {
    method: "POST",
    body: form,
    headers: { "user-agent": "vitest" },
  });
}

const csv = (contenido: string | Uint8Array, nombre = "padron.csv") => new File([contenido as BlobPart], nombre, { type: "text/csv" });
const previa = (...a: Parameters<typeof csv>) => vistaPrevia(pedido("vista-previa", [csv(...a)]));

beforeEach(() => {
  vi.clearAllMocks();
  sesion.rol = "admin";
  sesion.permitido = true;
  m.entrar.mockImplementation(async (_etiqueta: unknown, _cupo: unknown, ...roles: string[]) => {
    if (!roles.includes(sesion.rol)) throw new AppError("FORBIDDEN_ROLE");
    return {
      ctx: { user: { id: USER }, userRow: { id: USER, tenant_id: TENANT, role: sesion.rol, locale: null } },
      rl: { allowed: sesion.permitido },
    };
  });
  m.procesar.mockResolvedValue({ ok: true, resultado: RESULTADO });
});

describe("quién entra", () => {
  it.each(ROLES_QUE_ENTRAN)("el rol %s entra", async (rol) => {
    sesion.rol = rol;
    expect((await previa("dni,nombre\n30123456,Ana Pérez")).status).toBe(200);
  });

  it("un analista no llega a leer el archivo", async () => {
    sesion.rol = "analyst";
    const res = await previa("dni,nombre\n30123456,Ana Pérez");
    expect(res.status).toBe(403);
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("pasado el cupo contesta 429 sin procesar", async () => {
    sesion.permitido = false;
    expect((await previa("dni\n1")).status).toBe(429);
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("la vista previa y la importación comparten el cupo y piden los mismos roles", async () => {
    await previa("dni,nombre\n30123456,Ana Pérez");
    await importar(pedido("importar", [csv("dni,nombre\n30123456,Ana Pérez")]));
    const [[etiqueta1, , ...roles1], [etiqueta2, , ...roles2]] = m.entrar.mock.calls as [string[], string[]];
    expect(etiqueta1).toBe("padron-importar");
    expect(etiqueta2).toBe("padron-importar");
    expect(roles1).toEqual(ROLES_QUE_ENTRAN);
    expect(roles2).toEqual(ROLES_QUE_ENTRAN);
  });
});

describe("qué hace cada ruta", () => {
  it("la vista previa procesa sin aplicar y la importación aplicando", async () => {
    await previa("dni,nombre\n30123456,Ana Pérez");
    await importar(pedido("importar", [csv("dni,nombre\n30123456,Ana Pérez")]));
    expect(m.procesar.mock.calls.map((c) => c[2])).toEqual([false, true]);
  });

  it("el inquilino sale de la sesión, aunque el formulario traiga otro", async () => {
    await vistaPrevia(pedido("vista-previa", [csv("dni\n1")], { tenant_id: "otro", tenantId: "otro" }));
    expect(m.procesar).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, ip: "203.0.113.7", ua: "vitest" },
      "dni\n1",
      false
    );
  });

  it("devuelve las frases hechas, en el idioma de la cuenta", async () => {
    const res = await previa("dni,nombre\n30123456,Ana Pérez");
    const cuerpo = await res.json();
    expect(cuerpo.aplicado).toBe(false);
    expect(cuerpo.conteo).toEqual(RESULTADO.resumen);
    expect(cuerpo.resumen[0]).toBe("Vista previa: todavía no se guardó nada.");
    expect(cuerpo.resumen).toContain("Clientes: 1 nuevos, 0 con cambios, 0 sin cambios.");
    expect(cuerpo.error).toBeUndefined();
  });

  it("con errores de fila contesta 400 con el detalle y la frase de cada error", async () => {
    m.procesar.mockResolvedValue({
      ok: true,
      resultado: { ...RESULTADO, errores: [{ fila: 3, codigo: "dni_invalido" }], erroresTotal: 1 },
    });
    const res = await importar(pedido("importar", [csv("dni\n1")]));
    const cuerpo = await res.json();
    expect(res.status).toBe(400);
    expect(cuerpo.error.code).toBe("VALIDATION_FAILED");
    expect(cuerpo.errores).toEqual([{ fila: 3, codigo: "dni_invalido" }]);
    expect(cuerpo.resumen).toEqual([
      "No se importó nada. Corregí las filas con error y volvé a subir el archivo.",
      "Fila 3: El DNI no es válido: tiene que tener de 6 a 9 números.",
    ]);
  });

  it("un rechazo del archivo que viene del procesamiento sale con su frase", async () => {
    m.procesar.mockResolvedValue({ ok: false, error: "falta_columna_dni" });
    const res = await previa("nombre\nAna");
    const cuerpo = await res.json();
    expect(res.status).toBe(400);
    expect(cuerpo.resumen).toEqual(["Falta la columna «dni» en la primera fila."]);
  });
});

describe("el archivo", () => {
  it("sin archivo, 400 con la frase", async () => {
    const res = await vistaPrevia(pedido("vista-previa", []));
    expect(res.status).toBe(400);
    expect((await res.json()).resumen).toEqual(["Elegí un archivo CSV."]);
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("dos archivos, o un texto donde va el archivo, son «sin archivo»", async () => {
    expect((await vistaPrevia(pedido("vista-previa", [csv("dni\n1"), csv("dni\n2")]))).status).toBe(400);
    expect((await vistaPrevia(pedido("vista-previa", ["dni\n1"]))).status).toBe(400);
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("un archivo vacío es 400", async () => {
    const res = await previa("");
    expect(res.status).toBe(400);
    expect((await res.json()).resumen).toEqual(["El archivo no tiene filas de datos."]);
  });

  it("uno que pasa el tope es 413 y no se lee", async () => {
    const res = await previa("a".repeat(MAX_BYTES_DEL_ARCHIVO + 1));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("ARCHIVO_DEMASIADO_GRANDE");
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("uno justo en el tope se procesa", async () => {
    expect((await previa("a".repeat(MAX_BYTES_DEL_ARCHIVO))).status).toBe(200);
  });

  it("un pedido que anuncia más de lo que entra se corta por el encabezado", async () => {
    const req = new NextRequest("http://localhost/api/padron/vista-previa", {
      method: "POST",
      body: (() => {
        const f = new FormData();
        f.append("archivo", csv("dni\n1"));
        return f;
      })(),
      headers: { "content-length": String(MAX_BYTES_DEL_ARCHIVO * 4) },
    });
    const res = await vistaPrevia(req);
    expect(res.status).toBe(413);
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("un .xlsx (zip) es 422 con la frase que dice cómo salir", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    const res = await previa(zip, "padron.xlsx");
    expect(res.status).toBe(422);
    const cuerpo = await res.json();
    expect(cuerpo.error.code).toBe("ARCHIVO_NO_VALIDO");
    expect(cuerpo.resumen[0]).toMatch(/guardalo como CSV/);
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("un binario con un byte nulo es 422", async () => {
    expect((await previa(new Uint8Array([0x64, 0x6e, 0x69, 0x00, 0x2c]), "x.csv")).status).toBe(422);
    expect(m.procesar).not.toHaveBeenCalled();
  });

  it("un CSV en Windows-1252 (Excel en castellano) se lee con sus acentos", async () => {
    // "Pérez" con la é como el byte E9: no es UTF-8 válido.
    const bytes = new Uint8Array([...new TextEncoder().encode("dni,nombre\n30123456,P"), 0xe9, ...new TextEncoder().encode("rez")]);
    await previa(bytes);
    expect(m.procesar.mock.calls[0]![1]).toBe("dni,nombre\n30123456,Pérez");
  });

  it("un CSV en UTF-8 llega tal cual", async () => {
    await previa("dni,nombre\n30123456,Pérez");
    expect(m.procesar.mock.calls[0]![1]).toBe("dni,nombre\n30123456,Pérez");
  });
});
