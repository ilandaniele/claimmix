/**
 * El puente con `@vercel/oidc` de verdad, sin mock: que el token que Vercel
 * entrega llegue al supplier de STS tal cual, por el orden que fija la 4.x
 * (header del pedido, archivo `VERCEL_OIDC_TOKEN_FILE`, variable
 * `VERCEL_OIDC_TOKEN`), sin canje de audiencia, sin red y sin que un error
 * filtre el token. Qué arma `credencialesOidc` y que llama sin argumentos está
 * en `gcp-credenciales.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalAccountSupplierContext } from "google-auth-library";
import { credencialesOidc } from "@/server/gcp/credenciales";

const OIDC = {
  GCP_PROJECT_NUMBER: "1032332436198",
  GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel",
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel",
  GCP_SERVICE_ACCOUNT_EMAIL: "claimmix-extractor@claimmix-506321.iam.gserviceaccount.com",
};

// Donde el runtime de Vercel deja el pedido en curso (`getContext` de la lib).
const CONTEXTO = Symbol.for("@vercel/request-context");
const global = globalThis as unknown as Record<symbol, unknown>;

// Un JWT sin firmar que no vence: la lib sólo decodifica `exp` para decidir si refresca.
function jwt(sub: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.firma`;
}

async function tokenParaSts() {
  const c = credencialesOidc(OIDC);
  return c.subject_token_supplier!.getSubjectToken({
    audience: c.audience,
    subjectTokenType: c.subject_token_type,
  } as ExternalAccountSupplierContext);
}

describe("credencialesOidc con @vercel/oidc real", () => {
  let carpeta: string;
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), "oidc-"));
    fetch = vi.fn(async () => {
      throw new Error("sin red");
    });
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    delete global[CONTEXTO];
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(carpeta, { recursive: true, force: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("el header del pedido va tal cual, por encima de la variable", async () => {
    const delPedido = jwt("pedido");
    global[CONTEXTO] = { get: () => ({ headers: { "x-vercel-oidc-token": delPedido } }) };
    vi.stubEnv("VERCEL_OIDC_TOKEN", jwt("variable"));

    await expect(tokenParaSts()).resolves.toBe(delPedido);
  });

  it("sin header, el archivo VERCEL_OIDC_TOKEN_FILE gana a la variable y se recorta", async () => {
    const delArchivo = jwt("archivo");
    const ruta = join(carpeta, "token");
    writeFileSync(ruta, `${delArchivo}\n`);
    vi.stubEnv("VERCEL_OIDC_TOKEN_FILE", ruta);
    vi.stubEnv("VERCEL_OIDC_TOKEN", jwt("variable"));

    await expect(tokenParaSts()).resolves.toBe(delArchivo);
  });

  it("sin header ni archivo, la variable", async () => {
    const deVariable = jwt("variable");
    vi.stubEnv("VERCEL_OIDC_TOKEN", deVariable);

    await expect(tokenParaSts()).resolves.toBe(deVariable);
  });

  it("archivo vacío: falla sin caer a la variable y sin mostrar ningún token", async () => {
    const ruta = join(carpeta, "token");
    writeFileSync(ruta, "  \n");
    const deVariable = jwt("variable");
    vi.stubEnv("VERCEL_OIDC_TOKEN_FILE", ruta);
    vi.stubEnv("VERCEL_OIDC_TOKEN", deVariable);

    const error = await tokenParaSts().then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/token file is empty/);
    expect(error!.message).not.toContain(deVariable);
  });
});
