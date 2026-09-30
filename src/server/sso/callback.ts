import "server-only";

import { createHash } from "node:crypto";

import { createLocalJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import { revisarReclamos, type MotivoSso, type ReclamosSso } from "@/core/sso";
import { descifrar } from "@/lib/security/cifrado";
import { timingSafeStringEqual } from "@/lib/security/compare";
import { pedirFijado } from "@/server/red/https-fijado";

import { clavesDe, type ConfigSso, type Descubierto } from "./config";

/**
 * El lado del IdP del SSO, sin Better Auth: armar la URL de autorización, cambiar
 * el código por el token y decidir si ese token alcanza para dejar entrar.
 *
 * Todo lo que llega del IdP se trata como entrada de un tercero. El `id_token` se
 * verifica con las claves que el propio IdP publica, pero lo que lo ata a ESTA
 * aseguradora no es el IdP sino lo que guardamos nosotros: el `issuer` y el
 * `client_id` (iss y aud), el dominio verificado por DNS (el mail) y el nonce
 * que salió de este navegador.
 */

/** Sólo firmas asimétricas: un IdP que firme con HS256 usaría como clave el secreto del cliente. */
export const ALGORITMOS_ADMITIDOS = ["RS256", "ES256"];

const EDAD_MAXIMA_DEL_TOKEN = "10m";
const MARGEN_DE_RELOJ_SEGUNDOS = 60;
const PLAZO_MS = 8_000;
const TOPE_DE_LA_RESPUESTA = 64 * 1024;

/** El desafío PKCE (S256) de un `code_verifier`. */
export function desafioPkce(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export type PedidoDeAutorizacion = {
  config: Pick<ConfigSso, "client_id">;
  descubierto: Pick<Descubierto, "authorization_endpoint">;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  mail: string;
};

export function urlDeAutorizacion(p: PedidoDeAutorizacion): string {
  const url = new URL(p.descubierto.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.config.client_id);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", p.state);
  url.searchParams.set("nonce", p.nonce);
  url.searchParams.set("code_challenge", desafioPkce(p.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("login_hint", p.mail);
  return url.toString();
}

export type MotivoDeRechazo =
  | MotivoSso
  | "secreto_ilegible"
  | "sin_respuesta"
  | "respuesta_ilegible"
  | "sin_claves"
  | "token_invalido"
  | "azp"
  | "nonce";

export type IdentidadDelIdp =
  | { ok: true; email: string; sub: string; nombre: string | null }
  | { ok: false; motivo: MotivoDeRechazo };

export type PedidoDeIdentidad = {
  config: ConfigSso;
  descubierto: Descubierto;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** El nonce que salió de este navegador, recuperado del `state`. */
  nonce: string;
};

const RespuestaDelToken = z.object({ id_token: z.string().min(1) });

function formaDelPedido(p: PedidoDeIdentidad, secreto: string) {
  const cuerpo = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  });
  const encabezados: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (p.descubierto.autenticacion === "client_secret_post") {
    cuerpo.set("client_id", p.config.client_id);
    cuerpo.set("client_secret", secreto);
  } else {
    // RFC 6749 §2.3.1: usuario y clave van codificados como formulario antes del base64.
    const credencial = `${encodeURIComponent(p.config.client_id)}:${encodeURIComponent(secreto)}`;
    encabezados.Authorization = `Basic ${Buffer.from(credencial, "utf8").toString("base64")}`;
  }
  return { cuerpo: cuerpo.toString(), encabezados };
}

type Resultado<T> = { ok: true; valor: T } | { ok: false; motivo: MotivoDeRechazo };

async function pedirElToken(p: PedidoDeIdentidad): Promise<Resultado<string>> {
  let secreto: string;
  try {
    secreto = descifrar(p.config.client_secret_cifrado);
  } catch {
    return { ok: false, motivo: "secreto_ilegible" };
  }
  const { cuerpo, encabezados } = formaDelPedido(p, secreto);
  const respuesta = await pedirFijado({
    url: p.descubierto.token_endpoint,
    metodo: "POST",
    cuerpo,
    encabezados,
    plazoMs: PLAZO_MS,
    topeBytes: TOPE_DE_LA_RESPUESTA,
  });
  if (!respuesta.ok || respuesta.cuerpo === null) return { ok: false, motivo: "sin_respuesta" };
  try {
    return { ok: true, valor: RespuestaDelToken.parse(JSON.parse(respuesta.cuerpo)).id_token };
  } catch {
    return { ok: false, motivo: "respuesta_ilegible" };
  }
}

/**
 * Verifica firma, `iss`, `aud`, vencimiento y antigüedad con las claves del IdP.
 * Un `kid` que no está en la copia guardada se busca una vez más: es lo que pasa
 * cuando el IdP rota sus claves.
 */
async function verificarElToken(
  idToken: string,
  config: ConfigSso,
  descubierto: Descubierto
): Promise<Resultado<JWTPayload>> {
  const opciones = {
    issuer: config.issuer,
    audience: config.client_id,
    algorithms: ALGORITMOS_ADMITIDOS,
    maxTokenAge: EDAD_MAXIMA_DEL_TOKEN,
    clockTolerance: MARGEN_DE_RELOJ_SEGUNDOS,
    requiredClaims: ["iat", "exp"],
  };
  for (const refrescar of [false, true]) {
    const claves = await clavesDe(descubierto.jwks_uri, { refrescar });
    if (!claves) return { ok: false, motivo: "sin_claves" };
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(claves), opciones);
      return { ok: true, valor: payload };
    } catch (e) {
      if (!(e instanceof errors.JWKSNoMatchingKey) || refrescar) return { ok: false, motivo: "token_invalido" };
    }
  }
  return { ok: false, motivo: "token_invalido" };
}

/** Con varias audiencias, OIDC exige un `azp` que sea el cliente; con una sola, `azp` si viene debe serlo. */
function audienciaValida(payload: JWTPayload, clientId: string): boolean {
  const variasAudiencias = Array.isArray(payload.aud) && payload.aud.length > 1;
  if (payload.azp === undefined) return !variasAudiencias;
  return payload.azp === clientId;
}

/**
 * Del `code` del IdP a una persona identificada, o el motivo por el que no.
 * Nunca lanza: una falla de red o un token raro es un rechazo, no un 500.
 */
export async function identificarConElIdp(p: PedidoDeIdentidad): Promise<IdentidadDelIdp> {
  const token = await pedirElToken(p);
  if (!token.ok) return token;

  const verificado = await verificarElToken(token.valor, p.config, p.descubierto);
  if (!verificado.ok) return verificado;
  const payload = verificado.valor;

  if (!audienciaValida(payload, p.config.client_id)) return { ok: false, motivo: "azp" };
  if (typeof payload.nonce !== "string" || !timingSafeStringEqual(payload.nonce, p.nonce)) {
    return { ok: false, motivo: "nonce" };
  }

  const revision = revisarReclamos(payload as ReclamosSso, { dominio: p.config.dominio });
  if (!revision.ok) return { ok: false, motivo: revision.motivo };
  return revision;
}
