/**
 * Las piezas de los adjuntos del worker que no pasan por el modelo: qué se le
 * muestra, cuándo un archivo espera por plazos agotados y qué fotos se cruzan
 * contra el reclamo.
 */

vi.mock("server-only", () => ({}));

const { readAttachment, contarTokens } = vi.hoisted(() => ({ readAttachment: vi.fn(), contarTokens: vi.fn() }));

vi.mock("@/data/scope", () => ({ enTenant: vi.fn(), enTenantVarias: vi.fn() }));
vi.mock("@/server/storage/claim-attachments-bucket", () => ({ readAttachment }));
vi.mock("@/server/ai/gemini-extractor", () => ({ contarTokens }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/db/schema";
import { enTenant, enTenantVarias, type ClienteDatos } from "@/data/scope";
import type { Metadatos } from "@/core/adjuntos/firma";
import {
  anotarLecturas,
  cartasPendientes,
  conLecturasDeEstaCorrida,
  consultaPlazoAgotado,
  esperaPorPlazo,
  indiciosDeAdjuntos,
  lecturasPorHash,
  mecanicasDeAdjuntos,
  paraElModelo,
  type AdjuntoDelCaso,
  type ParaElModelo,
} from "@/server/worker/adjuntos";
import type { AdjuntoLeido, DocumentoLeido } from "@/lib/schemas/extracted-claim";

const AHORA = new Date("2026-09-20T15:00:00Z");
const HORA = 3_600_000;
const NADA: ParaElModelo = { hashes: [], media: [] };
const TENANT = { tenantId: "t-1" } as unknown as Parameters<typeof paraElModelo>[2];

const adjunto = (cambios: Partial<AdjuntoDelCaso> = {}): AdjuntoDelCaso => ({
  id: "adj-1",
  claim_message_id: "msg-1",
  content_type: "image/jpeg",
  storage_path: "t/c/a.jpg",
  content_hash: "h1",
  size_bytes: 100,
  resumen: null,
  util: null,
  rejected_reason: null,
  datos: null,
  metadatos: { firma: true },
  ...cambios,
});

const doc = (d: Partial<DocumentoLeido>): DocumentoLeido => ({
  tipo: null, fecha: null, patente: null, dni: null, nombre: null, lugar: null, provincia: null, ...d,
});

/** Una foto del 1 de septiembre, diez días antes del siniestro del reclamo. */
const vieja: Metadatos = { firma: true, tomadaEn: "2026-09-01T12:00:00Z" };

const cruzar = (adjuntos: AdjuntoDelCaso[], campos: Record<string, string> = { accident_date: "2026-09-10" }) =>
  indiciosDeAdjuntos({ adjuntos, vistos: NADA, lecturas: [], campos, poliza: undefined, ahora: AHORA }).map(
    (i) => i.clave
  );

beforeEach(() => {
  vi.clearAllMocks();
  readAttachment.mockResolvedValue(Buffer.from("bytes"));
  contarTokens.mockResolvedValue(2064);
});

describe("esperaPorPlazo", () => {
  const plazo = (veces: number, hace: number) => ({ plazoAgotado: { veces, en: new Date(Date.now() - hace).toISOString() } });

  it("un plazo agotado espera una hora; después vuelve a probar", () => {
    expect(esperaPorPlazo(plazo(1, 60_000))).toBe(true);
    expect(esperaPorPlazo(plazo(1, 2 * HORA))).toBe(false);
  });

  it("dos plazos agotados son el archivo: no vuelve", () => {
    expect(esperaPorPlazo(plazo(2, 30 * 24 * HORA))).toBe(true);
  });

  it("sin plazos agotados no espera", () => {
    expect(esperaPorPlazo(null)).toBe(false);
    expect(esperaPorPlazo({ firma: true })).toBe(false);
  });
});

describe("paraElModelo", () => {
  it("no manda audios ni lo que espera por un plazo agotado", async () => {
    const r = await paraElModelo(
      [
        adjunto({ id: "nota", content_type: "audio/ogg", content_hash: "ha" }),
        adjunto({
          id: "colgada",
          content_hash: "hc",
          metadatos: { firma: true, plazoAgotado: { veces: 1, en: new Date().toISOString() } },
        }),
        adjunto({ id: "pdf", content_type: "application/pdf; name=x.pdf", content_hash: "hp" }),
      ],
      "caso-1",
      TENANT
    );

    expect(r.hashes).toEqual(["hp"]);
    expect(r.media[0]!.mimeType).toBe("application/pdf");
  });

  /** Una foto y dos PDF; el de ruta «grande» es el que el mock de lectura distingue. */
  const tres = () =>
    paraElModelo(
      [
        adjunto({ id: "foto", content_hash: "hf" }),
        adjunto({ id: "grande", storage_path: "grande", content_type: "application/pdf", content_hash: "hg" }),
        adjunto({ id: "chico", content_type: "application/pdf", content_hash: "hc" }),
      ],
      "caso-1",
      TENANT
    );
  const sqlMarcado = () => {
    const db = drizzle(neon("postgres://u:p@h/db"), { schema }) as unknown as ClienteDatos;
    const consulta = vi.mocked(enTenant).mock.calls[0]![1] as unknown as (d: ClienteDatos) => { toSQL(): { sql: string; params: unknown[] } };
    return consulta(db).toSQL();
  };

  it("el PDF que el modelo cobraría de más no va y queda descartado; las fotos no se cuentan", async () => {
    const grande = Buffer.from("grande").toString("base64");
    readAttachment.mockImplementation(async (ruta: string) => Buffer.from(ruta));
    contarTokens.mockImplementation(async (m: { data: string }) => (m.data === grande ? 258_000 : 2064));

    const r = await tres();

    expect(r.hashes).toEqual(["hf", "hc"]);
    expect(contarTokens).toHaveBeenCalledTimes(2);
    expect(enTenant).toHaveBeenCalledTimes(1);
    const { sql, params } = sqlMarcado();
    expect(sql).toMatch(/set "metadatos" = \$1/);
    expect(params).toEqual(['{"descarte":"too_many_pages"}', "caso-1", "hg"]);
  });

  it("con Gemini 3 (560 tokens por página) un PDF de diez páginas va y uno de once no", async () => {
    const grande = Buffer.from("grande").toString("base64");
    readAttachment.mockImplementation(async (ruta: string) => Buffer.from(ruta));
    contarTokens.mockImplementation(async (m: { data: string }) => (m.data === grande ? 11 * 560 : 10 * 560));

    const r = await tres();

    expect(r.hashes).toEqual(["hf", "hc"]);
    expect(sqlMarcado().params).toEqual(['{"descarte":"too_many_pages"}', "caso-1", "hg"]);
  });

  it("un PDF que el modelo no puede leer queda descartado y no vuelve a contarse", async () => {
    const grande = Buffer.from("grande").toString("base64");
    readAttachment.mockImplementation(async (ruta: string) => Buffer.from(ruta));
    contarTokens.mockImplementation(async (m: { data: string }) => (m.data === grande ? "rechazo" : 2064));

    const r = await tres();

    expect(r.hashes).toEqual(["hf", "hc"]);
    expect(enTenant).toHaveBeenCalledTimes(1);
    expect(sqlMarcado().params).toEqual(['{"descarte":"pages_unknown"}', "caso-1", "hg"]);
  });

  it("un conteo que agota el plazo marca el PDF; uno que falla no lo manda ni lo marca", async () => {
    contarTokens.mockResolvedValueOnce("plazo").mockResolvedValueOnce(null);

    const r = await tres();

    expect(r.hashes).toEqual(["hf"]);
    expect(enTenant).toHaveBeenCalledTimes(1);
    const { sql, params } = sqlMarcado();
    expect(sql).toMatch(/'plazoAgotado'/);
    expect(params).toEqual(expect.arrayContaining(["caso-1", "hg"]));
    expect(params).not.toContain("hc");
  });
});

describe("consultaPlazoAgotado", () => {
  it("suma una vez y anota cuándo, sólo en los archivos del caso", () => {
    const db = drizzle(neon("postgres://u:p@h/db"), { schema }) as unknown as ClienteDatos;
    const { sql, params } = consultaPlazoAgotado(db, "caso-1", ["h1", "h2"]).toSQL();

    expect(sql).toMatch(/'plazoAgotado', jsonb_build_object\(\s*'veces', coalesce\(\("claim_attachments"\."metadatos"->'plazoAgotado'->>'veces'\)::int, 0\) \+ 1/);
    expect(sql).toMatch(/"case_id" = \$\d+ and "claim_attachments"\."content_hash" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["caso-1", "h1", "h2"]));
  });
});

describe("indiciosDeAdjuntos — fotos", () => {
  it("una foto útil que no es un documento, de antes del siniestro, marca", () => {
    expect(cruzar([adjunto({ resumen: "Paragolpes roto.", util: true, metadatos: vieja })])).toEqual(["foto_antes"]);
  });

  it("la foto de un DNI o de un registro no marca por su fecha", () => {
    const dni = adjunto({ resumen: "Un DNI.", util: true, datos: doc({ tipo: "DNI" }), metadatos: vieja });
    expect(cruzar([dni])).toEqual([]);
  });

  it("una foto sin leer, o leída como inútil, no marca", () => {
    expect(cruzar([adjunto({ metadatos: vieja })])).toEqual([]);
    expect(cruzar([adjunto({ resumen: "", util: false, metadatos: vieja })])).toEqual([]);
  });

  it("vale la lectura de esta corrida", () => {
    const foto = adjunto({ metadatos: vieja });
    const leer = (documento: DocumentoLeido | null) =>
      indiciosDeAdjuntos({
        adjuntos: [foto],
        vistos: { hashes: ["h1"], media: [] },
        lecturas: [{ indice: 1, resumen: "", util: true, documento, mecanica: null }],
        campos: { accident_date: "2026-09-10" },
        poliza: undefined,
        ahora: AHORA,
      }).map((i) => i.clave);

    expect(leer(null)).toEqual(["foto_antes"]);
    expect(leer(doc({ tipo: "licencia de conducir" }))).toEqual([]);
  });
});

describe("indiciosDeAdjuntos — el reclamo", () => {
  it("usa incident_date cuando no hay accident_date", () => {
    const foto = adjunto({ resumen: "Daños.", util: true, metadatos: vieja });
    expect(cruzar([foto], { incident_date: "2026-09-10" })).toEqual(["foto_antes"]);
  });

  it("la patente del asegurado cuenta con cualquiera de sus claves", () => {
    const parte = adjunto({ resumen: "Parte.", util: true, datos: doc({ patente: "AB123CD" }), metadatos: null });
    expect(cruzar([parte], { party_a_plate: "AB 123 CD" })).toEqual([]);
    expect(cruzar([parte], { vehicle_plate: "AB-123-CD" })).toEqual([]);
    expect(cruzar([parte], { party_a_plate: "ZZ999ZZ" })).toEqual(["documento_patente"]);
  });
});

describe("indiciosDeAdjuntos — la carta de un tercero (B24)", () => {
  const carta = adjunto({ resumen: "Carta.", util: true, datos: doc({ tipo: "carta_reclamo", patente: "ZZ999ZZ", nombre: "Marta Gómez" }), metadatos: null });
  const historia = adjunto({ id: "adj-2", resumen: "Historia.", util: true, datos: doc({ tipo: "historia_clinica", patente: "ZZ999ZZ" }), metadatos: null });

  it("la patente de quien reclama no se coteja contra la del asegurado", () => {
    expect(cruzar([carta], { party_a_plate: "AB123CD" })).toEqual([]);
  });

  it("con una carta en el caso, la historia clínica es del tercero y tampoco se coteja", () => {
    expect(cruzar([carta, historia], { party_a_plate: "AB123CD" })).toEqual([]);
  });

  it("sin carta, la historia clínica sigue cruzándose", () => {
    expect(cruzar([historia], { party_a_plate: "AB123CD" })).toEqual(["documento_patente"]);
  });

  it("los tipos se reconocen escritos como sea: el certificado médico y «Historia Clínica» también son del tercero", () => {
    const certificado = adjunto({ id: "adj-3", resumen: "Certificado.", util: true, datos: doc({ tipo: "Certificado Medico", patente: "ZZ999ZZ" }), metadatos: null });
    const otraHistoria = adjunto({ id: "adj-4", resumen: "Historia.", util: true, datos: doc({ tipo: "Historia Clinica", patente: "ZZ999ZZ" }), metadatos: null });
    expect(cruzar([carta, certificado, otraHistoria], { party_a_plate: "AB123CD" })).toEqual([]);
  });

  it("con una carta en el caso, un documento que no es médico sigue cruzándose", () => {
    const parte = adjunto({ id: "adj-5", resumen: "Parte.", util: true, datos: doc({ tipo: "parte", patente: "ZZ999ZZ" }), metadatos: null });
    expect(cruzar([carta, parte], { party_a_plate: "AB123CD" })).toEqual(["documento_patente"]);
  });
});

describe("cartasPendientes", () => {
  const leida = (datos: object | null, cambios: Partial<AdjuntoDelCaso> = {}) =>
    adjunto({ content_type: "application/pdf", storage_path: "t/c/a.pdf", datos: datos as AdjuntoDelCaso["datos"], ...cambios });

  it("una carta reconocida y sin leer a fondo está pendiente, escrita como sea", () => {
    expect(cartasPendientes([leida(doc({ tipo: "carta_reclamo" }))])).toHaveLength(1);
    expect(cartasPendientes([leida(doc({ tipo: "Carta Reclamo" }))])).toHaveLength(1);
  });

  it("una carta ya leída, aunque haya salido en null, no vuelve", () => {
    expect(cartasPendientes([leida({ ...doc({ tipo: "carta_reclamo" }), reclamo: null })])).toEqual([]);
    expect(cartasPendientes([leida({ ...doc({ tipo: "carta_reclamo" }), reclamo: { es_reclamo: true } })])).toEqual([]);
  });

  it("una carta que no se puede leer no vuelve, aunque el motivo sea el que sea", () => {
    for (const sin_leer of ["archivo", "paginas", "formato"]) {
      expect(cartasPendientes([leida({ ...doc({ tipo: "carta_reclamo" }), sin_leer })])).toEqual([]);
    }
  });

  it("el mismo archivo mandado dos veces es una sola carta pendiente", () => {
    const una = leida(doc({ tipo: "carta_reclamo" }));
    const misma = leida(doc({ tipo: "carta_reclamo" }), { id: "adj-2" });
    const otra = leida(doc({ tipo: "carta_reclamo" }), { id: "adj-3", content_hash: "h2" });
    expect(cartasPendientes([una, misma, otra]).map((a) => a.id)).toEqual(["adj-1", "adj-3"]);
  });

  it("sin hash de contenido no hay con qué juntar: cada fila es una carta", () => {
    const sinHash = (id: string) => leida(doc({ tipo: "carta_reclamo" }), { id, content_hash: null });
    expect(cartasPendientes([sinHash("a"), sinHash("b")]).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("otros documentos, archivos sin leer, descartados o sin archivo no cuentan", () => {
    expect(cartasPendientes([leida(doc({ tipo: "presupuesto" }))])).toEqual([]);
    expect(cartasPendientes([leida(null)])).toEqual([]);
    expect(cartasPendientes([leida(doc({ tipo: "carta_reclamo" }), { rejected_reason: "too_many_pages" })])).toEqual([]);
    expect(cartasPendientes([leida(doc({ tipo: "carta_reclamo" }), { storage_path: null })])).toEqual([]);
  });

  describe("los archivos del mensaje que llegó a un caso que el agente ya no lee", () => {
    const sinLeer = (cambios: Partial<AdjuntoDelCaso> = {}) =>
      adjunto({ content_type: "application/pdf", storage_path: "t/c/a.pdf", claim_message_id: "msg-9", ...cambios });

    it("un archivo de ese mensaje que nadie leyó se reconoce como posible carta", () => {
      expect(cartasPendientes([sinLeer()], "msg-9").map((a) => a.id)).toEqual(["adj-1"]);
      expect(cartasPendientes([sinLeer({ content_type: "image/jpeg" })], "msg-9")).toHaveLength(1);
    });

    it("sin indicar el mensaje, un archivo sin leer no es carta", () => {
      expect(cartasPendientes([sinLeer()])).toEqual([]);
    });

    it("los archivos de otro mensaje quedan afuera", () => {
      expect(cartasPendientes([sinLeer({ claim_message_id: "msg-1" })], "msg-9")).toEqual([]);
    });

    it("lo ya leído por el modelo, lo que no se mira, lo que no tiene firma o está descartado no cuenta", () => {
      expect(cartasPendientes([sinLeer({ resumen: "Foto." })], "msg-9")).toEqual([]);
      expect(cartasPendientes([sinLeer({ resumen: "" })], "msg-9")).toEqual([]);
      expect(cartasPendientes([sinLeer({ content_type: "audio/ogg" })], "msg-9")).toEqual([]);
      expect(cartasPendientes([sinLeer({ metadatos: null })], "msg-9")).toEqual([]);
      expect(cartasPendientes([sinLeer({ metadatos: {} })], "msg-9")).toEqual([]);
      expect(cartasPendientes([sinLeer({ rejected_reason: "too_many_pages" })], "msg-9")).toEqual([]);
      expect(cartasPendientes([sinLeer({ storage_path: null })], "msg-9")).toEqual([]);
    });

    it("el archivo que ya tiene documento leído no se vuelve a reconocer", () => {
      expect(cartasPendientes([sinLeer({ datos: doc({ tipo: "presupuesto" }) as AdjuntoDelCaso["datos"] })], "msg-9")).toEqual([]);
    });

    it("el gemelo de un archivo ya leído no se lee de nuevo, y dos gemelos sin leer son uno", () => {
      const leido = sinLeer({ id: "viejo", claim_message_id: "msg-1", resumen: "Foto." });
      expect(cartasPendientes([leido, sinLeer({ id: "nuevo" })], "msg-9")).toEqual([]);
      expect(cartasPendientes([sinLeer({ id: "a" }), sinLeer({ id: "b" })], "msg-9").map((a) => a.id)).toEqual(["a"]);
    });

    it("una carta reconocida antes sigue pendiente aunque sea de otro mensaje", () => {
      const reconocida = sinLeer({ id: "vieja", claim_message_id: "msg-1", datos: doc({ tipo: "carta_reclamo" }) as AdjuntoDelCaso["datos"] });
      expect(cartasPendientes([reconocida, sinLeer({ content_hash: "h2" })], "msg-9").map((a) => a.id)).toEqual(["vieja", "adj-1"]);
    });
  });
});

describe("lecturasPorHash", () => {
  const lectura = (indice: number, resumen = ""): AdjuntoLeido => ({ indice, resumen, util: true, documento: null, mecanica: null });
  const vistos: ParaElModelo = { hashes: ["h1", "h2"], media: [] };

  it("junta cada lectura con el hash del archivo que se le mostró al modelo", () => {
    const r = lecturasPorHash(vistos, [lectura(2, "b"), lectura(1, "a")]);
    expect([...r.keys()].sort()).toEqual(["h1", "h2"]);
    expect(r.get("h1")!.resumen).toBe("a");
  });

  it("un índice repetido se queda con la primera lectura", () => {
    const r = lecturasPorHash(vistos, [lectura(1, "primera"), lectura(1, "segunda")]);
    expect(r.size).toBe(1);
    expect(r.get("h1")!.resumen).toBe("primera");
  });

  it("un índice que no existe no cuenta", () => {
    expect(lecturasPorHash(vistos, [lectura(0), lectura(3), lectura(-1)]).size).toBe(0);
    expect(lecturasPorHash(NADA, [lectura(1)]).size).toBe(0);
  });
});

describe("conLecturasDeEstaCorrida", () => {
  const vistos: ParaElModelo = { hashes: ["h1", "h2"], media: [] };
  const lectura = (indice: number, documento: DocumentoLeido | null): AdjuntoLeido => ({
    indice,
    resumen: "",
    util: true,
    documento,
    mecanica: null,
  });

  it("la fila que esta corrida leyó lleva el documento, por el hash que se le mostró al modelo", () => {
    const [a, b] = conLecturasDeEstaCorrida(
      [adjunto({ id: "a", content_hash: "h1" }), adjunto({ id: "b", content_hash: "h2" })],
      vistos,
      [lectura(2, doc({ tipo: "carta_reclamo" }))]
    );
    expect(a!.datos).toBeNull();
    expect(b!.datos).toMatchObject({ tipo: "carta_reclamo" });
  });

  it("un archivo que no se le mostró al modelo, sin hash o leído como foto queda como estaba", () => {
    const filas = [adjunto({ id: "a", content_hash: "otro" }), adjunto({ id: "b", content_hash: null }), adjunto({ id: "c", content_hash: "h1" })];
    const r = conLecturasDeEstaCorrida(filas, vistos, [lectura(1, null), lectura(2, doc({ tipo: "parte" }))]);
    expect(r).toEqual(filas);
  });

  it("sin lecturas devuelve las filas tal cual", () => {
    const filas = [adjunto()];
    expect(conLecturasDeEstaCorrida(filas, vistos, [])).toEqual(filas);
  });
});

describe("mecanicasDeAdjuntos", () => {
  const mec = (c: Record<string, unknown> = {}) => ({
    maniobra_asegurado: null,
    maniobra_tercero: null,
    semaforo_asegurado: null,
    semaforo_tercero: null,
    interseccion: null,
    venia_por_la_derecha: null,
    embistio_de_atras: null,
    excepcion_prioridad: null,
    ...c,
  });
  const lectura = (indice: number, mecanica: AdjuntoLeido["mecanica"], documento: DocumentoLeido | null = doc({ tipo: "parte" })): AdjuntoLeido => ({
    indice,
    resumen: "",
    util: true,
    documento,
    mecanica,
  });
  const vistos: ParaElModelo = { hashes: ["h1", "h2"], media: [] };

  it("junta la de los archivos leídos antes y la de esta corrida", () => {
    const previo = adjunto({ datos: { ...doc({ tipo: "parte" }), mecanica: mec({ embistio_de_atras: "tercero" }) } });
    const r = mecanicasDeAdjuntos([previo], vistos, [lectura(1, mec({ semaforo_tercero: "rojo" }))]);
    expect(r.map((m) => m.embistio_de_atras ?? m.semaforo_tercero)).toEqual(["tercero", "rojo"]);
  });

  it("una mecánica toda en null no cuenta y una mal guardada tampoco tira", () => {
    const rota = adjunto({ datos: { ...doc({ tipo: "parte" }), mecanica: { maniobra_asegurado: "volaba" } as never } });
    expect(mecanicasDeAdjuntos([rota], vistos, [lectura(1, mec())])).toEqual([]);
  });

  it("la lectura de un archivo que no es un documento, o de un índice que no existe, no cuenta", () => {
    const suelta = mec({ embistio_de_atras: "asegurado" });
    expect(mecanicasDeAdjuntos([], vistos, [lectura(1, suelta, null), lectura(3, suelta), lectura(0, suelta)])).toEqual([]);
  });
});

describe("anotarLecturas — la mecánica (B18)", () => {
  const grabado: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    grabado.length = 0;
    vi.mocked(enTenantVarias).mockImplementation((async (_ctx: unknown, armar: (db: unknown) => unknown[]) => {
      const db = {
        update: () => ({
          set: (datos: Record<string, unknown>) => {
            grabado.push(datos);
            return { where: () => null };
          },
        }),
      };
      return armar(db);
    }) as never);
  });

  const mecanica = { maniobra_asegurado: null, maniobra_tercero: null, semaforo_asegurado: null, semaforo_tercero: "rojo", interseccion: null, venia_por_la_derecha: null, embistio_de_atras: null, excepcion_prioridad: null } as const;
  const parte = doc({ tipo: "parte" });

  it("un parte guarda su mecánica junto al documento", async () => {
    await anotarLecturas("caso-1", TENANT, { hashes: ["h1"], media: [] }, [{ indice: 1, resumen: "Parte.", util: true, documento: parte, mecanica }]);
    expect(grabado[0]!.datos).toEqual({ ...parte, mecanica });
  });

  it("sin mecánica el documento queda como estaba", async () => {
    await anotarLecturas("caso-1", TENANT, { hashes: ["h1"], media: [] }, [{ indice: 1, resumen: "Parte.", util: true, documento: parte, mecanica: null }]);
    expect(grabado[0]!.datos).toEqual(parte);
  });

  it("dice si guardó: sin nada que anotar sí, y una falla al escribir no tira pero dice que no", async () => {
    await expect(anotarLecturas("caso-1", TENANT, { hashes: ["h1"], media: [] }, [])).resolves.toBe(true);
    await expect(anotarLecturas("caso-1", TENANT, NADA, [])).resolves.toBe(true);
    expect(grabado).toHaveLength(1);

    vi.mocked(enTenantVarias).mockRejectedValueOnce(new Error("neon"));
    await expect(anotarLecturas("caso-1", TENANT, { hashes: ["h1"], media: [] }, [])).resolves.toBe(false);
  });

  it("una foto que no es documento sigue en null aunque traiga mecánica", async () => {
    await anotarLecturas("caso-1", TENANT, { hashes: ["h1"], media: [] }, [{ indice: 1, resumen: "Daños.", util: true, documento: null, mecanica }]);
    expect(grabado[0]!.datos).toBeNull();
  });
});
