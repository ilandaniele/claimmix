/**
 * Las piezas de los adjuntos del worker que no pasan por el modelo: qué se le
 * muestra, cuándo un archivo espera por plazos agotados y qué fotos se cruzan
 * contra el reclamo.
 */

vi.mock("server-only", () => ({}));

const { readAttachment } = vi.hoisted(() => ({ readAttachment: vi.fn() }));

vi.mock("@/data/scope", () => ({ enTenant: vi.fn(), enTenantVarias: vi.fn() }));
vi.mock("@/server/storage/claim-attachments-bucket", () => ({ readAttachment }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/db/schema";
import type { ClienteDatos } from "@/data/scope";
import type { Metadatos } from "@/core/adjuntos/firma";
import {
  consultaPlazoAgotado,
  esperaPorPlazo,
  indiciosDeAdjuntos,
  paraElModelo,
  type AdjuntoDelCaso,
  type ParaElModelo,
} from "@/server/worker/adjuntos";
import type { DocumentoLeido } from "@/lib/schemas/extracted-claim";

const AHORA = new Date("2026-09-20T15:00:00Z");
const HORA = 3_600_000;
const NADA: ParaElModelo = { hashes: [], media: [] };

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
    const r = await paraElModelo([
      adjunto({ id: "nota", content_type: "audio/ogg", content_hash: "ha" }),
      adjunto({
        id: "colgada",
        content_hash: "hc",
        metadatos: { firma: true, plazoAgotado: { veces: 1, en: new Date().toISOString() } },
      }),
      adjunto({ id: "pdf", content_type: "application/pdf; name=x.pdf", content_hash: "hp" }),
    ]);

    expect(r.hashes).toEqual(["hp"]);
    expect(r.media[0]!.mimeType).toBe("application/pdf");
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
        lecturas: [{ indice: 1, resumen: "", util: true, documento }],
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
