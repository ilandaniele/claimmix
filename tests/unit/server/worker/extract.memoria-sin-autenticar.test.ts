/**
 * E17, del lado del worker: sin SPF/DKIM del remitente, no se heredan pistas.
 *
 * `loadInboundConversation` ya resuelve `remitenteAutenticado` a partir de las
 * cabeceras del último entrante y del canal del caso (`remitenteVerificado`,
 * en `@/core/email/autenticacion`). Acá se prueba que el worker lea ese campo:
 * por `email` hace falta el veredicto alineado de Gmail; por `email_sim` sólo
 * que no haya una falla explícita.
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

const DMARC_PASS: Cabecera[] = [
  { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=ejemplo.com" },
];

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(cabecerasDelUltimo?: Cabecera[], channel = "email_sim") {
  vi.resetModules();
  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel }),
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

  it("en email_sim, con cabeceras limpias, pide pistas de memoria como siempre", async () => {
    expect(await correr()).toBe(1);
  });

  it("en email, con el dmarc=pass de Gmail, pide pistas de memoria", async () => {
    expect(await correr(DMARC_PASS, "email")).toBe(1);
  });

  it("en email, sin la cabecera de Gmail, no pide pistas de memoria", async () => {
    expect(await correr(undefined, "email")).toBe(0);
  });

  it("en email, con spf=fail, no pide pistas de memoria", async () => {
    expect(await correr(SPF_FAIL, "email")).toBe(0);
  });
});
