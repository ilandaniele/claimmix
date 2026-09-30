import "server-only";

import { randomBytes } from "node:crypto";

import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, isAPIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateState, handleOAuthUserInfo, parseState } from "better-auth/oauth2";
import { z } from "zod";

import { dominioDelMail, proveedorDeSso, RUTA_DE_VUELTA_SSO } from "@/core/sso";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { logger } from "@/lib/observability/logger";
import { identificarConElIdp, urlDeAutorizacion, type MotivoDeRechazo } from "@/server/sso/callback";
import { configVigenteDelInquilino, configVigentePorDominio, descubrir } from "@/server/sso/config";
import { CODIGO_SSO_OTRO_INQUILINO, CODIGO_SSO_REQUERIDO } from "@/server/sso/exigir";
import { duenoDelMail } from "@/server/sso/usuarios";

import { provisionUserProfile } from "./provision";
import { enIngresoPorSso } from "./registro-permitido";

/**
 * SSO por inquilino, como plugin propio de Better Auth.
 *
 * No se usa `@better-auth/sso` ni `generic-oauth`: los dos guardan una
 * configuración OIDC por proveedor pero ninguno sabe de inquilinos, de dominios
 * verificados por DNS ni de que el alta tiene que caer en UNA aseguradora. Acá
 * el inquilino sale de nuestra base, nunca del pedido.
 *
 * Dos rutas bajo `/api/auth`:
 *   POST /sso-inquilino/sign-in   devuelve la URL del IdP de ese dominio, o `null`.
 *   GET  /sso-inquilino/callback  vuelve del IdP, abre la sesión o vuelve a /login.
 */

const ORIGEN = "sso-inquilino";

/** A dónde va quien no trae un `errorCallbackURL` válido en el state. */
const LOGIN_POR_OMISION = "/login";

/** Lo único que /login sabe decir. Cualquier otro motivo queda en el log, no en la pantalla. */
const FALLO = "sso_fallo";
const CODIGOS_PARA_LA_PANTALLA = new Set([CODIGO_SSO_REQUERIDO, CODIGO_SSO_OTRO_INQUILINO]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Motivos que sólo aparecen con un token firmado por el IdP de ESE inquilino.
 * Sólo ésos van a su registro de auditoría: con un `state` armado por un tercero
 * (el `sign-in/social` de Better Auth acepta datos propios) cualquiera podría,
 * si no, llenar de filas el registro de otra aseguradora con códigos inventados.
 */
const MOTIVOS_CON_TOKEN_VALIDO = new Set<string>([
  "sin_email",
  "sin_sub",
  "email_no_verificado",
  "dominio_ajeno",
  "azp",
  "nonce",
  "sin_perfil",
  CODIGO_SSO_OTRO_INQUILINO,
]);

function conError(base: string, codigo: string): string {
  return `${base}${base.includes("?") ? "&" : "?"}error=${codigo}`;
}

const CuerpoDelIngreso = z.object({
  email: z.string().min(3).max(254),
  callbackURL: z.string().optional(),
  // Con valor por omisión: sin él, `parseState` rellena la URL de error de Better Auth
  // y un rechazo del callback caería en su página de error en vez de en /login.
  errorCallbackURL: z.string().default(LOGIN_POR_OMISION),
  newUserCallbackURL: z.string().optional(),
});

/** Sólo lo que Better Auth no valida por nosotros; el resto de la consulta del IdP se ignora. */
const ConsultaDelIdp = z.object({
  state: z.string().min(1).max(4096).optional(),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(256).optional(),
});

const iniciar = createAuthEndpoint(
  "/sso-inquilino/sign-in",
  { method: "POST", body: CuerpoDelIngreso },
  async (c) => {
    /*
     * Siempre la misma forma de respuesta. Un dominio sin SSO, uno sin verificar
     * y un IdP caído contestan igual `{ url: null }`: de otro modo este endpoint
     * sirve para averiguar qué aseguradoras usan la plataforma.
     */
    const dominio = dominioDelMail(c.body.email);
    const config = dominio ? await configVigentePorDominio(dominio) : null;
    if (!config) return c.json({ url: null });

    const descubierto = await descubrir(config.issuer);
    if (!descubierto.ok) {
      logger.warn({ tenant_id: config.tenant_id, motivo: descubierto.motivo }, "sso.descubrimiento_fallo");
      return c.json({ url: null });
    }

    const nonce = randomBytes(24).toString("base64url");
    const { state, codeVerifier } = await generateState(c, {
      additionalData: { tenantId: config.tenant_id, origen: ORIGEN },
      idTokenNonce: nonce,
    });
    return c.json({
      url: urlDeAutorizacion({
        config,
        descubierto: descubierto.datos,
        redirectUri: `${c.context.baseURL}${RUTA_DE_VUELTA_SSO}`,
        state,
        nonce,
        codeVerifier,
        mail: c.body.email,
      }),
    });
  }
);

const volverDelIdp = createAuthEndpoint(
  "/sso-inquilino/callback",
  { method: "GET" },
  async (c) => {
    const consulta = ConsultaDelIdp.safeParse(c.query ?? {});
    if (!consulta.success || !consulta.data.state) throw c.redirect(conError(LOGIN_POR_OMISION, FALLO));

    let estado: Awaited<ReturnType<typeof parseState>>;
    try {
      estado = await parseState(c);
    } catch {
      // parseState ya avisó en el log; de la cookie del navegador no se sale con otra cosa.
      throw c.redirect(conError(LOGIN_POR_OMISION, FALLO));
    }
    // El ingreso siempre lo guarda en el state; el `??` es sólo para el tipo.
    const errorURL = estado.errorURL ?? LOGIN_POR_OMISION;

    /*
     * El inquilino sale SÓLO del state, que va firmado y atado a este navegador
     * por una cookie. Ningún parámetro de la consulta decide de qué aseguradora
     * se trata. Y aunque el state pudiera armarlo un tercero, no alcanza: lo que
     * deja entrar es el token que firma el IdP de ese inquilino.
     */
    const tenantId = typeof estado.tenantId === "string" && UUID.test(estado.tenantId) ? estado.tenantId : null;
    const nonce = typeof estado.idTokenNonce === "string" ? estado.idTokenNonce : null;
    if (!tenantId || !nonce || estado.origen !== ORIGEN) throw c.redirect(conError(errorURL, FALLO));

    const rechazar = async (motivo: MotivoDeRechazo | string, codigo = FALLO): Promise<never> => {
      logger.warn({ tenant_id: tenantId, motivo }, "sso.rechazado");
      if (MOTIVOS_CON_TOKEN_VALIDO.has(motivo)) {
        await writeAuditLog({
          tenant_id: tenantId,
          event_type: AuditEvent.SSO_RECHAZADO,
          payload: { motivo },
        });
      }
      throw c.redirect(conError(errorURL, CODIGOS_PARA_LA_PANTALLA.has(codigo) ? codigo : FALLO));
    };

    const { code, error } = consulta.data;
    if (error || !code) return rechazar(error ? "idp_error" : "sin_codigo");

    const config = await configVigenteDelInquilino(tenantId);
    if (!config) return rechazar("sin_config");
    const descubierto = await descubrir(config.issuer);
    if (!descubierto.ok) return rechazar(descubierto.motivo);

    const identidad = await identificarConElIdp({
      config,
      descubierto: descubierto.datos,
      code,
      codeVerifier: estado.codeVerifier,
      redirectUri: `${c.context.baseURL}${RUTA_DE_VUELTA_SSO}`,
      nonce,
    });
    if (!identidad.ok) return rechazar(identidad.motivo);

    /*
     * Antes de crear o vincular nada: ¿ese mail ya es de otra aseguradora? El
     * dominio verificado alcanza para dar de alta a quien no existe, nunca para
     * tocar la cuenta de alguien que ya pertenece a otro inquilino.
     *
     * Si ya es de ESTE inquilino se vincula por id (`selectedUser`). Sin eso Better
     * Auth no une una cuenta local con `emailVerified = false`, que es la de casi
     * todos —acá no se manda mail de verificación— y el SSO les contestaría
     * «sso_fallo» justo a quienes «Exigir SSO» deja sin contraseña, el admin incluido.
     * Alcanza porque el IdP de la aseguradora dio el mail por verificado y el
     * inquilino de la cuenta es el del state.
     *
     * Una cuenta sin perfil se rechaza, salvo la que quedó de un primer ingreso por
     * este SSO que creó usuario y cuenta y falló al crear el perfil (`huerfanaDeSso`):
     * esa se recupera dándole el perfil ahora. Sin esto el reintento se quedaba en
     * «sin_perfil» para siempre y nadie más que un admin podía destrabarlo.
     */
    const dueno = await duenoDelMail(identidad.email, tenantId);
    if (dueno.existe) {
      if (dueno.tenantId === null && !dueno.huerfanaDeSso) return rechazar("sin_perfil");
      if (dueno.tenantId !== null && dueno.tenantId !== tenantId) {
        return rechazar(CODIGO_SSO_OTRO_INQUILINO, CODIGO_SSO_OTRO_INQUILINO);
      }
    }
    const recuperada = dueno.existe && dueno.huerfanaDeSso;

    const proveedor = proveedorDeSso(tenantId);
    let resultado: Awaited<ReturnType<typeof handleOAuthUserInfo>>;
    try {
      resultado = await enIngresoPorSso({ tenantId, dominio: config.dominio }, async () => {
        // El perfil va antes de la sesión: el gancho de sesión busca el inquilino de la cuenta.
        if (recuperada) {
          await provisionUserProfile({
            id: dueno.userId,
            name: identidad.nombre ?? identidad.email,
            email: identidad.email,
            emailVerified: true,
          });
        }
        return handleOAuthUserInfo(c, {
          userInfo: {
            id: identidad.sub,
            email: identidad.email,
            name: identidad.nombre ?? identidad.email,
            emailVerified: true,
          },
          // Sin tokens: el SSO sólo identifica, no hay nada del IdP que guardar.
          account: { providerId: proveedor, accountId: identidad.sub },
          callbackURL: estado.callbackURL,
          overrideUserInfo: false,
          selectedUser: dueno.existe ? { userId: dueno.userId, profile: "preserve" } : undefined,
          source: { method: "oauth", oauth: { providerId: proveedor } },
        });
      });
    } catch (e) {
      const codigo = isAPIError(e) ? String(e.body?.code ?? "") : "";
      return rechazar(codigo || "error_interno", codigo);
    }
    if (resultado.error || !resultado.data) return rechazar((resultado.error || "sin_datos").split(" ").join("_"));

    const { session, user } = resultado.data;
    await setSessionCookie(c, { session, user });

    if (resultado.isRegister || recuperada) {
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: user.id,
        event_type: AuditEvent.SSO_INGRESO_JIT,
        target_type: "user",
        target_id: user.id,
      });
    }
    throw c.redirect(estado.callbackURL);
  }
);

export const ssoInquilino = () =>
  ({
    id: "sso-inquilino",
    endpoints: { signInSsoInquilino: iniciar, callbackSsoInquilino: volverDelIdp },
  }) satisfies BetterAuthPlugin;
