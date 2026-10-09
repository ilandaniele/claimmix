/**
 * La salud de las bases por cliente y del desfase de migraciones (P11).
 *
 * Ningún deploy migra nada: entre que sale el código y que alguien corre
 * `migrar-bases.mjs` hay una ventana en la que a una base le faltan columnas. Con
 * `BASE_POR_CLIENTE=1`, `/api/health?deep=1` la informa en `bases.desfase`, y el job
 * de post-deploy de prd falla si es true. El HTTP sigue en 200 y el estado pasa a
 * `degraded`.
 *
 * También se prueba que los chequeos del trabajo miran CADA base: con la bandera
 * prendida los casos viven en la base de cada inquilino, y mirar sólo control daría
 * cero y verde.
 *
 * Control se simula por el texto de la consulta (la ruta hace muchas contra el mismo
 * `db.execute`); las bases de cliente, por `dbDeBase`.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** `db.execute`: control. */
  control: vi.fn(),
  select: vi.fn(),
  /** `dbDeBase(nombre).execute`: una base de cliente. */
  base: vi.fn(),
  dbDeBase: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));
vi.mock("@/lib/db", () => ({
  db: { execute: h.control, select: h.select },
  dbDeBase: h.dbDeBase,
  tables: { cases: { id: "id" } },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));
// `?deep=1` sube un archivo a R2 y le pregunta al modelo: acá no hay ni uno ni otro.
vi.mock("@/server/storage/claim-attachments-bucket", () => {
  let subido: Buffer | null = null;
  return {
    uploadAttachment: async (a: { data: Buffer }) => {
      subido = a.data;
      return { storagePath: "health/check" };
    },
    readAttachment: async () => subido,
    deleteAttachment: async () => undefined,
  };
});
vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: async () => ({ text: '{"ok": true}' }),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/health/route";
import { VERSION_ESPERADA } from "@/server/bases/plantilla.generated";

const dialecto = new PgDialect();
const textoDe = (q: unknown) => dialecto.sqlToQuery(q as SQL).sql;

const SECRET = "un-secreto-largo-y-aburrido";
const GUARDADO = process.env.BASE_POR_CLIENTE;

const UNA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTRA = "11111111-2222-3333-4444-555555555555";
const nombre = (id: string) => `t_${id.replaceAll("-", "")}`;

const NOMBRE_DEL_CHEQUEO = "bases por cliente";

/** Lo que devuelve la consulta de control para el informe de bases; cada test pisa lo suyo. */
type FilaDeBases = Record<string, number | null>;
const alDia = (): FilaDeBases => ({
  total: 2,
  lista: 2,
  creando: 0,
  fallida: 0,
  borrada: 0,
  creando_viejas: 0,
  version_min: VERSION_ESPERADA,
  version_max: VERSION_ESPERADA,
  version_control: VERSION_ESPERADA,
  sin_terminar: 0,
});

let informe: FilaDeBases;
let listas: string[];
/** Lo que contesta cada base a las cuatro consultas del trabajo, y quién falla. */
let enBase: (base: string, texto: string) => unknown;

function request(query = "?deep=1"): NextRequest {
  return new NextRequest(`https://claimmix-prd.vercel.app/api/health${query}`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

type Chequeo = { name: string; status: string; detail: string };

async function leer(query?: string) {
  const res = await GET(request(query));
  const body = (await res.json()) as {
    status: string;
    checks: Chequeo[];
    bases?: Record<string, unknown>;
  };
  const chequeo = (nombre: string) => body.checks.find((c) => c.name === nombre);
  return { res, body, bases: chequeo(NOMBRE_DEL_CHEQUEO), chequeo };
}

const sinNada = (texto: string) =>
  /outbound_messages|claim_attachments|from cases/.test(texto)
    ? { rows: [{ n: 0 }] }
    : { rows: [{ malas: 0, total: 0 }] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_ACCESS_KEY_ID = "test-r2-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-r2-secret-key";
  process.env.R2_BUCKET = "bucket";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete process.env.GMAIL_TENANT_ID;
  process.env.BASE_POR_CLIENTE = "1";

  informe = alDia();
  listas = [UNA, OTRA];
  enBase = (_base, texto) => sinNada(texto);

  h.control.mockImplementation((q: unknown) => {
    const texto = textoDe(q);
    if (texto.includes("version_control")) return Promise.resolve({ rows: [informe] });
    if (texto.includes("from public.tenant_bases") && texto.includes("estado = 'lista'")) {
      return Promise.resolve({ rows: listas.map((tenant_id) => ({ tenant_id })) });
    }
    // El esquema no es lo que se prueba acá: que no se pueda verificar es `degraded`, no `down`.
    if (texto.includes("information_schema")) return Promise.reject(new Error("fuera de este test"));
    if (texto.includes("ai_usage")) return Promise.resolve({ rows: [{ total: 0 }] });
    if (texto.includes("select 1")) return Promise.resolve({ rows: [{ "?column?": 1 }] });
    return Promise.resolve(sinNada(texto));
  });
  h.select.mockReturnValue({
    from: () => ({ limit: () => Promise.resolve([]), where: () => ({ limit: () => Promise.resolve([]) }) }),
  });
  h.dbDeBase.mockImplementation((base: string) => ({
    execute: (q: unknown) => Promise.resolve(enBase(base, textoDe(q))),
  }));
});

afterEach(() => {
  for (const k of ["CRON_SECRET", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "GEMINI_API_KEY"]) {
    delete process.env[k];
  }
  if (GUARDADO === undefined) delete process.env.BASE_POR_CLIENTE;
  else process.env.BASE_POR_CLIENTE = GUARDADO;
});

const consultoBases = () =>
  h.control.mock.calls.some(([q]) => textoDe(q).includes("version_control"));

describe("/api/health?deep=1 sin la bandera", () => {
  beforeEach(() => {
    delete process.env.BASE_POR_CLIENTE;
  });

  it("no suma la clave `bases` ni el chequeo, y no mira tenant_bases", async () => {
    const { res, body, bases } = await leer();

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("bases");
    expect(bases).toBeUndefined();
    expect(consultoBases()).toBe(false);
    expect(h.dbDeBase).not.toHaveBeenCalled();
  });
});

describe("/api/health con la bandera pero sin deep", () => {
  it("tampoco: el informe de bases es de `deep=1`", async () => {
    const { body, bases } = await leer("");

    expect(body).not.toHaveProperty("bases");
    expect(bases).toBeUndefined();
    expect(consultoBases()).toBe(false);
  });
});

describe("/api/health?deep=1 con la bandera", () => {
  it("con las migraciones al día informa `bases` con todos sus campos y el chequeo en ok", async () => {
    informe = { ...alDia(), total: 3, lista: 2, creando: 1, borrada: 0, sin_terminar: 1 };

    const { res, body, bases } = await leer();

    expect(res.status).toBe(200);
    expect(body.bases).toEqual({
      total: 3,
      lista: 2,
      creando: 1,
      fallida: 0,
      borrada: 0,
      creandoViejas: 0,
      versionMin: VERSION_ESPERADA,
      versionMax: VERSION_ESPERADA,
      versionEsperada: VERSION_ESPERADA,
      versionControl: VERSION_ESPERADA,
      sinTerminar: 1,
      desfase: false,
    });
    expect(bases?.status).toBe("ok");
  });

  it("una base `lista` atrás de lo que el código espera es desfase: 200 y `degraded`", async () => {
    informe = { ...alDia(), version_min: VERSION_ESPERADA - 1 };

    const { res, body, bases } = await leer();

    expect(res.status).toBe(200);
    expect(body.bases?.desfase).toBe(true);
    expect(body.bases?.versionMin).toBe(VERSION_ESPERADA - 1);
    expect(bases?.status).toBe("degraded");
    expect(bases?.detail).toContain("desfase");
    expect(body.status).toBe("degraded");
  });

  it("control atrás de lo que el código espera también es desfase", async () => {
    informe = { ...alDia(), version_control: VERSION_ESPERADA - 1 };

    const { res, body, bases } = await leer();

    expect(res.status).toBe(200);
    expect(body.bases?.desfase).toBe(true);
    expect(body.bases?.versionControl).toBe(VERSION_ESPERADA - 1);
    expect(bases?.status).toBe("degraded");
    expect(body.status).toBe("degraded");
  });

  it("un registro vacío en control no prueba que esté al día", async () => {
    informe = { ...alDia(), version_control: null };

    const { body, bases } = await leer();

    expect(body.bases?.versionControl).toBeNull();
    expect(body.bases?.desfase).toBe(true);
    expect(bases?.status).toBe("degraded");
  });

  it("sin ninguna base `lista` no hay versión mínima y eso no es desfase", async () => {
    informe = { ...alDia(), total: 1, lista: 0, creando: 1, version_min: null, version_max: null };

    const { body, bases } = await leer();

    expect(body.bases).toMatchObject({ lista: 0, versionMin: null, versionMax: null, desfase: false });
    expect(bases?.status).toBe("ok");
  });

  it("una base que lleva demasiado en `creando` degrada aunque no haya desfase", async () => {
    informe = { ...alDia(), creando: 1, creando_viejas: 1 };

    const { res, body, bases } = await leer();

    expect(res.status).toBe(200);
    expect(body.bases).toMatchObject({ creandoViejas: 1, desfase: false });
    expect(bases?.status).toBe("degraded");
    expect(bases?.detail).toContain("creando");
    expect(body.status).toBe("degraded");
  });

  it("los inquilinos sin fila y las bases fallidas se informan, pero no degradan solos", async () => {
    informe = { ...alDia(), fallida: 1, sin_terminar: 2 };

    const { body, bases } = await leer();

    expect(body.bases).toMatchObject({ fallida: 1, sinTerminar: 2, desfase: false });
    expect(bases?.status).toBe("ok");
  });

  it("es una sola consulta a control que nombra cada columna que la ruta lee", async () => {
    // Las filas de este test las inventa el mock: lo único que ata sus nombres a la
    // consulta de verdad es mirar que el SQL los declare.
    await leer();

    const consultas = h.control.mock.calls.map(([q]) => textoDe(q)).filter((t) => t.includes("version_control"));
    expect(consultas).toHaveLength(1);
    const declaradas = [...consultas[0]!.matchAll(/ as (\w+)/g)].map((m) => m[1]);
    expect(declaradas.sort()).toEqual(Object.keys(alDia()).sort());
    // Las versiones son de las bases `lista`: una que recién se crea no está en `0`.
    expect(consultas[0]).toMatch(/min\(b\.version_migracion\) filter \(where b\.estado = 'lista'\)/);
    expect(consultas[0]).toMatch(/max\(b\.version_migracion\) filter \(where b\.estado = 'lista'\)/);
  });

  it("si no se pudo medir lo dice y no inventa un informe", async () => {
    // 42P01: control sin la 0050. Un chequeo que no consultó no dice que está todo bien.
    const sinTabla = Object.assign(new Error("no existe"), { code: "42P01" });
    h.control.mockImplementation((q: unknown) => {
      const texto = textoDe(q);
      if (texto.includes("version_control")) return Promise.reject(sinTabla);
      if (texto.includes("information_schema")) return Promise.reject(new Error("fuera de este test"));
      if (texto.includes("ai_usage")) return Promise.resolve({ rows: [{ total: 0 }] });
      return Promise.resolve(sinNada(texto));
    });
    listas = [];

    const { res, body, bases } = await leer();

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("bases");
    expect(bases?.status).toBe("degraded");
    expect(bases?.detail).toContain("42P01");
  });
});

describe("los chequeos del trabajo con la bandera", () => {
  it("suman los casos trabados de todas las bases, no los de control", async () => {
    enBase = (base, texto) => (texto.includes("from cases") && base === nombre(OTRA) ? { rows: [{ n: 2 }] } : sinNada(texto));

    const { res, chequeo } = await leer();

    expect(res.status).toBe(503);
    expect(chequeo("casos trabados")?.status).toBe("down");
    expect(chequeo("casos trabados")?.detail).toContain("2 caso");
    expect(h.dbDeBase).toHaveBeenCalledWith(nombre(UNA));
    expect(h.dbDeBase).toHaveBeenCalledWith(nombre(OTRA));
  });

  it("la proporción de fallos del modelo es la de todas las bases juntas", async () => {
    // 1 de 10 en una y 4 de 10 en la otra: 25 % en total, arriba del tope.
    enBase = (base, texto) =>
      texto.includes("provider_usage_events")
        ? { rows: [{ malas: base === nombre(UNA) ? 1 : 4, total: 10 }] }
        : sinNada(texto);

    const { chequeo } = await leer();

    expect(chequeo("extracción")?.status).toBe("degraded");
    expect(chequeo("extracción")?.detail).toContain("25%");
  });

  it("los envíos y los adjuntos perdidos también se suman", async () => {
    enBase = (_base, texto) =>
      /outbound_messages|claim_attachments/.test(texto) ? { rows: [{ n: 3 }] } : sinNada(texto);

    const { chequeo } = await leer();

    expect(chequeo("envíos al denunciante")?.detail).toContain("6 sin salir");
    expect(chequeo("adjuntos")?.detail).toContain("6 no llegaron");
  });

  it("una base que no se pudo leer baja el `ok` a `degraded`: el verde no se inventa", async () => {
    enBase = (base, texto) => {
      if (base === nombre(OTRA)) throw Object.assign(new Error("no existe"), { code: "3D000" });
      return sinNada(texto);
    };

    const { chequeo } = await leer();

    for (const nombreDelChequeo of ["casos trabados", "extracción", "envíos al denunciante", "adjuntos"]) {
      expect(chequeo(nombreDelChequeo)?.status, nombreDelChequeo).toBe("degraded");
      expect(chequeo(nombreDelChequeo)?.detail, nombreDelChequeo).toContain("sin medir en 1 base");
    }
  });

  it("si no se pudo ni listar las bases, tampoco da verde", async () => {
    h.control.mockImplementation((q: unknown) => {
      const texto = textoDe(q);
      if (texto.includes("estado = 'lista'")) return Promise.reject(new Error("sin red"));
      if (texto.includes("information_schema")) return Promise.reject(new Error("fuera de este test"));
      if (texto.includes("ai_usage")) return Promise.resolve({ rows: [{ total: 0 }] });
      return Promise.resolve(sinNada(texto));
    });

    const { chequeo } = await leer("");

    expect(chequeo("casos trabados")?.status).toBe("degraded");
    expect(chequeo("casos trabados")?.detail).toContain("sin medir");
  });

  it("sin la bandera miran control una sola vez, como siempre", async () => {
    delete process.env.BASE_POR_CLIENTE;
    h.control.mockImplementation((q: unknown) => {
      const texto = textoDe(q);
      if (texto.includes("information_schema")) return Promise.reject(new Error("fuera de este test"));
      if (texto.includes("ai_usage")) return Promise.resolve({ rows: [{ total: 0 }] });
      if (texto.includes("from cases")) return Promise.resolve({ rows: [{ n: 1 }] });
      return Promise.resolve(sinNada(texto));
    });

    const { chequeo } = await leer("");

    expect(chequeo("casos trabados")?.status).toBe("down");
    expect(h.dbDeBase).not.toHaveBeenCalled();
  });
});
