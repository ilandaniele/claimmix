/**
 * El borde HTTP de la importación del padrón (B16), compartido por la vista
 * previa y la importación: las dos reciben el mismo multipart y corren el mismo
 * plan, y sólo una escribe.
 *
 * Multipart con un solo campo `archivo`: un CSV de texto de hasta
 * `MAX_BYTES_DEL_ARCHIVO`. Un .xlsx (que es un zip) o cualquier binario se
 * rechaza con una frase que dice cómo salir del paso, en vez de leerlo como
 * basura y contestar cien errores de fila.
 *
 * Auth: quienes editan el padrón. El inquilino sale de la sesión, nunca del
 * pedido. Vista previa e importación comparten el cupo: pedir la vista previa
 * es leer el archivo entero y consultar el padrón, igual que importarlo.
 */

import { type NextRequest, NextResponse } from "next/server";

import { MAX_BYTES_DEL_ARCHIVO } from "@/core/padron/csv";
import type { ErrorDeArchivo } from "@/core/padron/filas";
import { err } from "@/lib/api/respond";
import { ERROR_STATUS, type ErrorCode } from "@/lib/errors";
import { getClientIp, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";

import { entrarAEscribir, rechazo } from "./escritura";
import { procesarPadron } from "./importar";
import { lineasDelPadron } from "./lineas";

// Lo que el multipart agrega al archivo: fronteras y nombres de campo.
const MARGEN_DEL_MULTIPART = 64 * 1024;

const CODIGO_HTTP: Partial<Record<ErrorDeArchivo, ErrorCode>> = {
  archivo_muy_grande: "ARCHIVO_DEMASIADO_GRANDE",
  archivo_no_admitido: "ARCHIVO_NO_VALIDO",
};

/** Un zip (xlsx, docx) empieza por «PK»; un binario lleva NUL en las primeras líneas. */
function pareceBinario(bytes: Uint8Array): boolean {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return true;
  return bytes.subarray(0, 8192).includes(0);
}

/** UTF-8 y, si el archivo no lo es, Windows-1252: así guarda un CSV el Excel en castellano. */
function aTexto(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function manejarPadron(request: NextRequest, aplicar: boolean): Promise<Response> {
  try {
    const { userRow, t } = await entrarAEscribir("padron-importar", RATE_LIMIT_CONFIGS.PADRON_IMPORTAR);

    /** Un rechazo del archivo entero, con la frase que la pantalla muestra. */
    const rechazar = (codigo: ErrorDeArchivo) => rechazo(t, [codigo], CODIGO_HTTP[codigo]);

    if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES_DEL_ARCHIVO + MARGEN_DEL_MULTIPART) {
      return rechazar("archivo_muy_grande");
    }
    const form = await request.formData().catch(() => null);
    const archivos = form?.getAll("archivo") ?? [];
    const archivo = archivos[0];
    if (archivos.length !== 1 || !(archivo instanceof File)) return rechazar("sin_archivo");
    if (archivo.size > MAX_BYTES_DEL_ARCHIVO) return rechazar("archivo_muy_grande");
    if (archivo.size === 0) return rechazar("archivo_vacio");

    const bytes = new Uint8Array(await archivo.arrayBuffer());
    if (pareceBinario(bytes)) return rechazar("archivo_no_admitido");

    const salida = await procesarPadron(
      {
        tenantId: userRow.tenant_id,
        userId: userRow.id,
        ip: getClientIp(request),
        ua: request.headers.get("user-agent"),
      },
      aTexto(bytes),
      aplicar
    );
    if (!salida.ok) return rechazar(salida.error);

    const { resultado } = salida;
    const conErrores = resultado.erroresTotal > 0;
    return NextResponse.json(
      {
        aplicado: resultado.aplicado,
        conteo: resultado.resumen,
        errores: resultado.errores,
        erroresTotal: resultado.erroresTotal,
        ignoradas: resultado.ignoradas,
        resumen: lineasDelPadron(t, resultado),
        ...(conErrores && { error: { code: "VALIDATION_FAILED", message: t("padron.resultado.conErrores") } }),
      },
      { status: conErrores ? ERROR_STATUS.VALIDATION_FAILED : 200 }
    );
  } catch (e) {
    return err(e);
  }
}
