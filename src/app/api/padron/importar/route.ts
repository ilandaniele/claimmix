/**
 * POST /api/padron/importar — importa el CSV del padrón de clientes y pólizas (B16).
 *
 * Multipart con el campo `archivo`. Todo o nada: un solo error de fila y no se
 * guarda ninguna. Es la misma función (`procesarPadron`) que usaría una API de
 * corredores; el detalle del borde vive en `@/server/padron/ruta`.
 */

import { type NextRequest } from "next/server";

import { manejarPadron } from "@/server/padron/ruta";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<Response> {
  return manejarPadron(request, true);
}
