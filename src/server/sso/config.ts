import "server-only";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { JSONWebKeySet } from "jose";
import { z } from "zod";

import { enTenant, type ClienteDatos } from "@/data/scope";
import { db } from "@/lib/db";
import { ssoSettings } from "@/lib/db/schema";
import { revisarForma } from "@/server/core-sync/destino";
import { codigoPg, esFaltaDe0036 } from "@/server/core-sync/config";
import { pedirFijado } from "@/server/red/https-fijado";

/** Falta la tabla o una columna: el código puede llegar antes que la 0045, que se aplica a mano. */
export const esFaltaDe0045 = esFaltaDe0036;

export { codigoPg };

/** Lo que hace falta para hablar con el IdP de un inquilino, con el secreto todavía cifrado. */
export type ConfigSso = {
  tenant_id: string;
  issuer: string;
  client_id: string;
  client_secret_cifrado: string;
  dominio: string;
};

const CAMPOS_DE_LA_CONFIG = {
  tenant_id: ssoSettings.tenant_id,
  issuer: ssoSettings.issuer,
  client_id: ssoSettings.client_id,
  client_secret_cifrado: ssoSettings.client_secret_cifrado,
  dominio: ssoSettings.dominio,
};

/** Con todo lo que hace falta para hablar con el IdP y el dominio ya probado. */
export const CONFIG_COMPLETA = and(
  isNotNull(ssoSettings.dominio_verificado_en),
  isNotNull(ssoSettings.issuer),
  isNotNull(ssoSettings.client_id),
  isNotNull(ssoSettings.client_secret_cifrado),
  isNotNull(ssoSettings.dominio)
);

/** Sólo vale una config prendida, con el dominio probado y completa. */
const VIGENTE = and(eq(ssoSettings.activo, true), CONFIG_COMPLETA);

type FilaDeLaConfig = {
  [K in keyof ConfigSso]: string | null;
};

function completa(fila: FilaDeLaConfig | undefined): ConfigSso | null {
  if (!fila?.tenant_id || !fila.issuer || !fila.client_id || !fila.client_secret_cifrado || !fila.dominio) {
    return null;
  }
  return { ...fila } as ConfigSso;
}

/** La fila vigente del inquilino del contexto. Sin WHERE tenant_id: la elige RLS (hay una por inquilino). */
export function consultaDeLaConfigVigente(db: ClienteDatos) {
  return db.select(CAMPOS_DE_LA_CONFIG).from(ssoSettings).where(VIGENTE).limit(1);
}

/** Lo que ve /configuracion: nunca el secreto, sólo si hay uno. */
export const CAMPOS_DE_LA_VISTA = {
  issuer: ssoSettings.issuer,
  client_id: ssoSettings.client_id,
  dominio: ssoSettings.dominio,
  dominio_verificado_en: ssoSettings.dominio_verificado_en,
  activo: ssoSettings.activo,
  exigir: ssoSettings.exigir,
  tiene_secreto: sql<boolean>`${ssoSettings.client_secret_cifrado} is not null`,
};

export function vistaDeLaConfigSso(db: ClienteDatos) {
  return db.select(CAMPOS_DE_LA_VISTA).from(ssoSettings);
}

export type VistaDeLaConfigSso = Awaited<ReturnType<typeof vistaDeLaConfigSso>>[number];

/** La config vigente de un inquilino ya identificado (por el `state` firmado de la vuelta del IdP). */
export async function configVigenteDelInquilino(tenantId: string): Promise<ConfigSso | null> {
  try {
    const [fila] = await enTenant({ tenantId }, (db) => consultaDeLaConfigVigente(db));
    return completa(fila);
  } catch (e) {
    if (esFaltaDe0045(e)) return null;
    throw e;
  }
}

/** El dominio verificado es único en toda la tabla: a lo sumo una fila. */
export async function configVigentePorDominio(dominio: string): Promise<ConfigSso | null> {
  try {
    // sin-inquilino: el login es previo al inquilino; lo que lo determina es el
    // dominio del mail, que el índice único deja en una sola aseguradora.
    const [fila] = await db
      .select(CAMPOS_DE_LA_CONFIG)
      .from(ssoSettings)
      .where(and(eq(ssoSettings.dominio, dominio), VIGENTE))
      .limit(1);
    return completa(fila);
  } catch (e) {
    if (esFaltaDe0045(e)) return null;
    throw e;
  }
}

// ── Discovery y claves del IdP ──────────────────────────────────────────────
//
// El IdP lo escribe un admin de una aseguradora: todo pedido a una URL suya
// (documento de configuración, token, claves) sale por `pedirFijado`, que
// conecta a la IP validada y no sigue redirecciones. `createRemoteJWKSet` de
// jose usa `fetch` y se saltea esa guarda, así que las claves se bajan acá y se
// le entregan a jose ya descargadas (`createLocalJWKSet`).

const PLAZO_MS = 5_000;
const TOPE_DEL_DOCUMENTO = 64 * 1024;
const TOPE_DE_LAS_CLAVES = 256 * 1024;
const VIDA_EN_MEMORIA_MS = 5 * 60_000;
const MAXIMO_EN_MEMORIA = 100;

export type Descubierto = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** Cómo se autentica el cliente en el token endpoint: `client_secret_basic` si el IdP no dice otra cosa. */
  autenticacion: "client_secret_basic" | "client_secret_post";
};

export type MotivoDeDescubrimiento =
  | "issuer_invalido"
  | "sin_respuesta"
  | "documento_ilegible"
  | "issuer_no_coincide"
  | "endpoint_rechazado";

export type ResultadoDeDescubrimiento =
  | { ok: true; datos: Descubierto }
  | { ok: false; motivo: MotivoDeDescubrimiento };

const Documento = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

function formaValida(url: string): boolean {
  try {
    revisarForma(url);
    return true;
  } catch {
    return false;
  }
}

type EnMemoria<T> = { valor: T; vence: number };

const descubiertos = new Map<string, EnMemoria<Descubierto>>();
const clavesDelIdp = new Map<string, EnMemoria<JSONWebKeySet>>();

function guardar<T>(mapa: Map<string, EnMemoria<T>>, clave: string, valor: T): void {
  if (mapa.size >= MAXIMO_EN_MEMORIA) mapa.clear();
  mapa.set(clave, { valor, vence: Date.now() + VIDA_EN_MEMORIA_MS });
}

function vigenteEnMemoria<T>(mapa: Map<string, EnMemoria<T>>, clave: string): T | null {
  const hallado = mapa.get(clave);
  return hallado && hallado.vence > Date.now() ? hallado.valor : null;
}

/** Para los tests: nada de lo que quedó de un IdP anterior. */
export function olvidarLosIdps(): void {
  descubiertos.clear();
  clavesDelIdp.clear();
}

/**
 * El documento de configuración del IdP, revisado. `usarMemoria: false` lo pide
 * de nuevo (al guardar la config, para no validar contra algo viejo).
 */
export async function descubrir(
  issuer: string,
  { usarMemoria = true }: { usarMemoria?: boolean } = {}
): Promise<ResultadoDeDescubrimiento> {
  if (!formaValida(issuer)) return { ok: false, motivo: "issuer_invalido" };

  const guardado = usarMemoria ? vigenteEnMemoria(descubiertos, issuer) : null;
  if (guardado) return { ok: true, datos: guardado };

  const respuesta = await pedirFijado({
    url: `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    encabezados: { Accept: "application/json" },
    plazoMs: PLAZO_MS,
    topeBytes: TOPE_DEL_DOCUMENTO,
  });
  if (!respuesta.ok || respuesta.cuerpo === null) return { ok: false, motivo: "sin_respuesta" };

  let documento: z.infer<typeof Documento>;
  try {
    documento = Documento.parse(JSON.parse(respuesta.cuerpo));
  } catch {
    return { ok: false, motivo: "documento_ilegible" };
  }

  // Exacto, sin normalizar: el `iss` de los tokens se compara contra este mismo valor.
  if (documento.issuer !== issuer) return { ok: false, motivo: "issuer_no_coincide" };
  if (
    !formaValida(documento.authorization_endpoint) ||
    !formaValida(documento.token_endpoint) ||
    !formaValida(documento.jwks_uri)
  ) {
    return { ok: false, motivo: "endpoint_rechazado" };
  }

  const metodos = documento.token_endpoint_auth_methods_supported;
  const datos: Descubierto = {
    authorization_endpoint: documento.authorization_endpoint,
    token_endpoint: documento.token_endpoint,
    jwks_uri: documento.jwks_uri,
    autenticacion:
      metodos && !metodos.includes("client_secret_basic") && metodos.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic",
  };
  if (usarMemoria) guardar(descubiertos, issuer, datos);
  return { ok: true, datos };
}

const Claves = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });

/**
 * Las claves públicas del IdP. `refrescar` se usa una sola vez por verificación,
 * cuando el token trae un `kid` que la copia en memoria no conoce (rotación).
 */
export async function clavesDe(jwksUri: string, { refrescar = false } = {}): Promise<JSONWebKeySet | null> {
  const guardadas = refrescar ? null : vigenteEnMemoria(clavesDelIdp, jwksUri);
  if (guardadas) return guardadas;

  const respuesta = await pedirFijado({
    url: jwksUri,
    encabezados: { Accept: "application/json" },
    plazoMs: PLAZO_MS,
    topeBytes: TOPE_DE_LAS_CLAVES,
  });
  if (!respuesta.ok || respuesta.cuerpo === null) return null;

  try {
    const claves = Claves.parse(JSON.parse(respuesta.cuerpo)) as JSONWebKeySet;
    guardar(clavesDelIdp, jwksUri, claves);
    return claves;
  } catch {
    return null;
  }
}
