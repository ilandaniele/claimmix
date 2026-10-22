/**
 * POST /api/denuncia/[slug] — el formulario web público de denuncias (B17).
 *
 * Sin sesión: quien denuncia no tiene cuenta. El inquilino sale del enlace
 * público (`slug`), nunca del cuerpo del pedido, y el slug no es el id
 * interno. Defensas, en orden y sin CAPTCHA de terceros: tope por IP, tamaño
 * del cuerpo, campo trampa, token firmado por la página (con hora mínima y
 * máxima), tope por formulario y tope por dirección de correo. Un bot que
 * llena la trampa recibe el mismo éxito que una persona y no se crea nada.
 * Pasado el tope diario del formulario el envío abre caso igual, pero lo lee
 * una persona en vez de la IA.
 * Nunca se cuelga de un caso existente: cada envío abre uno, y un envío
 * repetido (mismo token, correo y relato) abre uno solo.
 *
 * Dos formas de llamarla. La página pública no lleva JavaScript: su formulario
 * HTML manda `application/x-www-form-urlencoded` y espera una redirección de
 * vuelta a la página con el resultado en `?r=`. Cualquier otro cliente manda
 * JSON y recibe JSON.
 */

import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { direccionCanonica } from "@/core/email/direccion-canonica";
import { sinControlNiAngulares } from "@/core/text/sin-control";
import { PATRON_DE_CORREO, PATRON_DE_TELEFONO, slugValido } from "@/core/web/formulario";
import { ok, err } from "@/lib/api/respond";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { AppError } from "@/lib/errors";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import {
  getClientIp,
  rateLimit,
  RATE_LIMIT_CONFIGS,
} from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { esSlugDeOtroAmbiente, urlDelOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import { marcarParaResponderAunqueSigaElAgente } from "@/server/cases/para-responder";
import { faltaLa0044 } from "@/server/core-sync/config";
import { dispatchExtractionWorker } from "@/server/worker/despachar-extraccion";
import { inquilinoDelFormulario } from "@/server/web/formulario";
import { ingresarDenunciaWeb } from "@/server/web/ingreso";
import { verificarToken } from "@/server/web/token";

export const dynamic = "force-dynamic";

const MAX_BYTES = 20_000;

const DenunciaSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .refine(sinControlNiAngulares, "caracteres no permitidos"),
  // El correo y el teléfono se validan con las mismas expresiones que la página pone en `pattern`.
  email: z.string().trim().max(254).regex(PATRON_DE_CORREO),
  telefono: z
    .string()
    .trim()
    .regex(PATRON_DE_TELEFONO)
    .or(z.literal(""))
    .optional()
    .transform((v) => v || null),
  // El navegador cuenta cada salto de línea como 1 y manda 2 (CRLF): se cuenta como lo contó quien escribió.
  relato: z
    .string()
    .transform((s) => s.replace(/\r\n?/g, "\n"))
    .pipe(
      z
        .string()
        .trim()
        .min(10)
        .max(5000)
        // El relato sí lleva saltos de línea; el resto de los caracteres de control, no.
        .refine((s) => !/[^\P{Cc}\n\r\t]/u.test(s), "caracteres no permitidos")
    ),
  // El token firmado que trajo la página.
  t: z.string().max(200),
  // El campo trampa: una persona no lo ve, un bot que llena todo lo completa.
  sitio: z.string().max(200).optional(),
});

const CAMPOS_DEL_FORMULARIO = [
  "nombre",
  "email",
  "telefono",
  "relato",
  "t",
  "sitio",
] as const;

const esJson = (request: NextRequest) =>
  (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("application/json");

/** Lo que mandó el formulario HTML: sólo las claves conocidas, la primera de cada una. */
function cuerpoDelFormulario(texto: string): Record<string, string> {
  const params = new URLSearchParams(texto);
  const cuerpo: Record<string, string> = {};
  for (const campo of CAMPOS_DEL_FORMULARIO) {
    const valor = params.get(campo);
    if (valor !== null) cuerpo[campo] = valor;
  }
  return cuerpo;
}

/** Sólo el hash, de la dirección canónica: la de un tercero no se guarda en la tabla de cupos, y sus alias comparten cupo. */
const huellaDelCorreo = (email: string) =>
  createHash("sha256")
    .update(direccionCanonica(email) ?? email.trim().toLowerCase())
    .digest("hex");

const rechazoPorCupo = (cupo: { retryAfterSeconds: number }) =>
  err(new AppError("RATE_LIMITED"), undefined, {
    "Retry-After": String(cupo.retryAfterSeconds),
  });

async function recibir(
  request: NextRequest,
  slug: string,
  comoJson: boolean
): Promise<Response> {
  try {
    const ip = getClientIp(request);

    const cupo = await rateLimit(
      claveDeCupo("denuncia-web", ip),
      RATE_LIMIT_CONFIGS.DENUNCIA_WEB
    );
    if (!cupo.allowed) return rechazoPorCupo(cupo);

    const declarado = Number(request.headers.get("content-length") ?? 0);
    if (declarado > MAX_BYTES) throw new AppError("ARCHIVO_DEMASIADO_GRANDE");
    const texto = await request.text();
    if (texto.length > MAX_BYTES)
      throw new AppError("ARCHIVO_DEMASIADO_GRANDE");

    let cuerpo: unknown;
    if (comoJson) {
      try {
        cuerpo = JSON.parse(texto);
      } catch {
        throw new AppError("VALIDATION_FAILED");
      }
    } else {
      cuerpo = cuerpoDelFormulario(texto);
    }
    const parsed = DenunciaSchema.safeParse(cuerpo);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED");
    const { sitio, t, ...denuncia } = parsed.data;

    // Éxito de mentira: el bot no se entera de que la trampa existe.
    if (sitio) return ok({ recibida: true });

    if (verificarToken(t, slug) !== "ok")
      throw new AppError("VALIDATION_FAILED");

    // Los dos topes de acá en adelante cuentan sólo envíos con token firmado: el enlace ya existe.
    const porFormulario = await rateLimit(
      claveDeCupo("denuncia-slug", slug),
      RATE_LIMIT_CONFIGS.DENUNCIA_WEB_SLUG
    );
    if (!porFormulario.allowed) return rechazoPorCupo(porFormulario);
    const porCorreo = await rateLimit(
      claveDeCupo("denuncia-mail", huellaDelCorreo(denuncia.email)),
      RATE_LIMIT_CONFIGS.DENUNCIA_WEB_MAIL
    );
    if (!porCorreo.allowed) return rechazoPorCupo(porCorreo);

    const formulario = await inquilinoDelFormulario(slug).catch(faltaLa0044);
    if (!formulario) throw new AppError("NOT_FOUND");
    const { tenantId } = formulario;

    const ingreso = await ingresarDenunciaWeb({
      tenantId,
      nombre: denuncia.nombre,
      email: denuncia.email,
      telefono: denuncia.telefono,
      relato: denuncia.relato,
      envio: t,
      ip,
    }).catch(faltaLa0044);
    // El mismo envío llegó dos veces (doble clic, reintento del navegador): el primero ya abrió el caso y mandó el correo.
    if (!ingreso) {
      logger.info({ slug }, "denuncia_web.repetida");
      return ok({ recibida: true });
    }
    const { caseId } = ingreso;

    // Cuenta acá y no con los otros topes: sólo un envío que abrió caso gasta cupo del día, y los repetidos y la trampa no llegan. Del tope en adelante el caso queda guardado y lo lee una persona, no la IA.
    const porDia = await rateLimit(
      claveDeCupo("denuncia-slug-dia", slug),
      RATE_LIMIT_CONFIGS.DENUNCIA_WEB_SLUG_DIA
    );
    if (!porDia.allowed) {
      await marcarParaResponderAunqueSigaElAgente(caseId, tenantId).catch((error) =>
        logger.error(
          { case_id: caseId, error_code: errorCode(error) },
          "denuncia_web.tope_diario.no_se_pudo_marcar"
        )
      );
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.MESSAGE_NOT_READ,
        target_type: "case",
        target_id: caseId,
        payload: { motivo: "tope_por_formulario", channel: "web" },
      });
      logger.info({ case_id: caseId }, "denuncia_web.tope_diario");
      // La persona no distingue: su denuncia quedó recibida.
      return ok({ recibida: true });
    }

    await dispatchExtractionWorker(caseId, tenantId);
    logger.info({ case_id: caseId }, "denuncia_web.recibida");

    return ok({ recibida: true });
  } catch (e) {
    return err(e);
  }
}

/** Lo que la página le cuenta a quien envió, según cómo terminó el pedido. */
function resultadoDeLaRedireccion(estado: number): string | null {
  if (estado === 200) return "enviada";
  if (estado === 429) return "limite";
  if (estado >= 500) return "error";
  // Sin formulario en ese enlace (apagado o inexistente): la página misma da 404.
  return estado === 404 ? null : "invalida";
}

/** De vuelta a la página. `slug` ya pasó `slugValido`: no hay redirección abierta. */
function volverALaPagina(slug: string, estado: number): Response {
  const resultado = resultadoDeLaRedireccion(estado);
  const destino = `/denuncia/${slug}${resultado ? `?r=${resultado}` : ""}`;
  return new Response(null, { status: 303, headers: { Location: destino } });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  // Un enlace con otro formato no existe: ni cupo, ni lectura del cuerpo, ni redirección con él.
  if (!slugValido(slug)) return err(new AppError("NOT_FOUND"));
  // El formulario es de dev: 308 conserva el método y el cuerpo, así que un envío embebido con el enlace viejo llega igual.
  if (esSlugDeOtroAmbiente(slug)) {
    const destino = urlDelOtroAmbiente(`/api/denuncia/${slug}`);
    if (destino) return NextResponse.redirect(destino, 308);
  }
  const comoJson = esJson(request);
  const respuesta = await recibir(request, slug, comoJson);
  return comoJson ? respuesta : volverALaPagina(slug, respuesta.status);
}
