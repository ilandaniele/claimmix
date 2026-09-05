import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: vi.fn(async () => "jwt-de-vercel"),
}));

import { getVercelOidcToken } from "@vercel/oidc";
import type { ExternalAccountSupplierContext } from "google-auth-library";
import { credencialesOidc, modoDeCredenciales } from "@/server/gcp/credenciales";

const OIDC = {
  GCP_PROJECT_NUMBER: "1032332436198",
  GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel",
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel",
  GCP_SERVICE_ACCOUNT_EMAIL: "claimmix-extractor@claimmix-506321.iam.gserviceaccount.com",
};

describe("modoDeCredenciales", () => {
  it("oidc gana sobre la clave", () => {
    expect(modoDeCredenciales({ ...OIDC, GOOGLE_SERVICE_ACCOUNT_JSON: "{}" })).toBe("oidc");
  });

  it("con una de las cuatro variables en blanco cae a la clave", () => {
    expect(
      modoDeCredenciales({ ...OIDC, GCP_SERVICE_ACCOUNT_EMAIL: " ", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" })
    ).toBe("clave");
  });

  it("sin nada es adc", () => {
    expect(modoDeCredenciales({})).toBe("adc");
  });
});

describe("credencialesOidc", () => {
  it("arma audiencia e impersonación con el número de proyecto", () => {
    const c = credencialesOidc(OIDC);
    expect(c.audience).toBe(
      "//iam.googleapis.com/projects/1032332436198/locations/global/workloadIdentityPools/vercel/providers/vercel"
    );
    expect(c.service_account_impersonation_url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/claimmix-extractor@claimmix-506321.iam.gserviceaccount.com:generateAccessToken"
    );
    expect(c.subject_token_type).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(c.token_url).toBe("https://sts.googleapis.com/v1/token");
  });

  it("pide el token de Vercel sin argumentos aunque la librería pase un contexto", async () => {
    const c = credencialesOidc(OIDC);
    const jwt = await c.subject_token_supplier!.getSubjectToken({
      audience: c.audience,
      subjectTokenType: c.subject_token_type,
    } as ExternalAccountSupplierContext);
    expect(jwt).toBe("jwt-de-vercel");
    expect(getVercelOidcToken).toHaveBeenCalledWith();
  });
});
