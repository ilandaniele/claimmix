/**
 * E17, del lado del worker: sin SPF/DKIM del remitente, no se heredan pistas.
 *
 * `loadInboundConversation` ya resuelve `remitenteAutenticado` a partir de las
 * cabeceras del último entrante (`@/core/email/autenticacion`). Acá se prueba
 * que el worker lea ese campo: con `spf=fail` no llama a `loadMemoryHints`, y
 * con cabeceras limpias (o sin conversación, atrás compatible) sigue
 * llamándolo como siempre.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";
import type { Cabecera } from "@/core/email/autenticacion";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "sinauth-test-0000-0000-000000000001";
const TENANT_ID = "sinauth-test-0000-0000-000000000002";

const CONVERSACION = {
  enviado: "2026-09-25T10:00:00.000Z",
  mensajes: [["Choqué en Alem", "2026-09-25T10:01:00.000Z"]] as Array<[string, string]>,
};

const SPF_FAIL: Cabecera[] = [
  { name: "Authentication-Results", value: "mx.google.com; spf=fail smtp.mailfrom=x@y" },
];

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(cabecerasDelUltimo?: Cabecera[]) {
  vi.resetModules();
  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID),
    espiaDeUpdate: vi.fn(),
    conversacion: CONVERSACION,
    cabecerasDelUltimo,
  });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const { loadMemoryHints } = await import("@/server/memory/load");
  return vi.mocked(loadMemoryHints).mock.calls.length;
}

describe("runEmailExtractionWorker — memoria y remitente sin autenticar (E17)", () => {
  it("con spf=fail en el último entrante, no pide pistas de memoria", async () => {
    expect(await correr(SPF_FAIL)).toBe(0);
  });

  it("con cabeceras limpias, pide pistas de memoria como siempre", async () => {
    expect(await correr()).toBe(1);
  });
});
