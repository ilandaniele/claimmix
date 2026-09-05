import "server-only";
import { GoogleAuth, type IdentityPoolClientOptions } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/oidc";

export type ModoGcp = "oidc" | "clave" | "adc";

type Env = Record<string, string | undefined>;
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

const OIDC_VARS = [
  "GCP_PROJECT_NUMBER",
  "GCP_WORKLOAD_IDENTITY_POOL_ID",
  "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  "GCP_SERVICE_ACCOUNT_EMAIL",
] as const;

export function modoDeCredenciales(env: Env = process.env): ModoGcp {
  if (OIDC_VARS.every((v) => env[v]?.trim())) return "oidc";
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) return "clave";
  return "adc";
}

// Workload Identity Federation: Vercel's OIDC token (a request header, read by
// the supplier on each refresh) exchanged at STS, then impersonating the SA.
// `getVercelOidcToken` takes NO arguments here: the library passes a context
// carrying `audience`, which would make Vercel mint a custom-audience token.
export function credencialesOidc(env: Env = process.env): IdentityPoolClientOptions {
  const [numero, pool, proveedor, sa] = OIDC_VARS.map((v) => env[v]!.trim());
  return {
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${numero}/locations/global/workloadIdentityPools/${pool}/providers/${proveedor}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`,
    subject_token_supplier: { getSubjectToken: () => getVercelOidcToken() },
  };
}

function credencialesClave(env: Env): Record<string, unknown> {
  try {
    return JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON!.trim());
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON");
  }
}

let auth: GoogleAuth | null = null;
let modo: ModoGcp | null = null;

export async function tokenDeGcp(): Promise<string> {
  if (!auth) {
    modo = modoDeCredenciales();
    const credentials =
      modo === "oidc"
        ? credencialesOidc()
        : modo === "clave"
          ? credencialesClave(process.env)
          : undefined;
    auth = new GoogleAuth({ credentials, scopes: SCOPES });
    console.log(
      JSON.stringify({ level: "info", service: "claimmix", msg: "gcp.credenciales", modo })
    );
  }
  const res = await (await auth.getClient()).getAccessToken();
  const token = typeof res === "string" ? res : res?.token;
  if (!token) throw new Error(`GCP: sin token de acceso (modo ${modo})`);
  return token;
}
