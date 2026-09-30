/**
 * POST /api/padron/vista-previa — qué haría importar este CSV, sin guardar nada (B16).
 *
 * Multipart con el campo `archivo`. Devuelve las altas, las modificaciones y
 * los errores por fila; el detalle vive en `@/server/padron/ruta`.
 */

import { type NextRequest } from "next/server";

import { manejarPadron } from "@/server/padron/ruta";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<Response> {
  return manejarPadron(request, false);
}
