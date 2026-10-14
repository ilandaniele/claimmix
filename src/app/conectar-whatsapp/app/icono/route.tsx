/**
 * GET /conectar-whatsapp/app/icono — el ícono de la app de Meta del cliente, que Meta pide
 * subir en «App icon» y el cliente todavía no tiene.
 *
 * Un PNG de 1024 × 1024 con las iniciales de su empresa sobre un color fijo. Es una ruta
 * privada (pide la sesión de quien arma el alta) y está fuera de /api para que el proxy la
 * proteja como a la pantalla que la usa. Hecho con `ImageResponse`: solo flexbox y la
 * tipografía por omisión.
 */

import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";

import { ADMIN_ROLES, requireRole } from "@/lib/auth/require-role";
import { AppError } from "@/lib/errors";
import { leerWabaPublica } from "@/server/alta/waba-publica";

import { inicialesDe } from "../iniciales";

const LADO = 1024;
const FONDO = "#4f46e5";

export async function GET() {
  let tenantId: string;
  try {
    tenantId = (await requireRole(...ADMIN_ROLES)).userRow.tenant_id;
  } catch (e) {
    const sinSesion = e instanceof AppError && e.code === "MISSING_SESSION";
    return new NextResponse(null, { status: sinSesion ? 401 : 403 });
  }

  // Nunca rechaza: sin lectura sale el ícono genérico en vez de una pantalla de error.
  const nombre = (await leerWabaPublica(tenantId))?.nombre ?? "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: FONDO,
          color: "#ffffff",
          fontSize: 460,
          fontWeight: 700,
        }}
      >
        {inicialesDe(nombre)}
      </div>
    ),
    {
      width: LADO,
      height: LADO,
      headers: {
        "Content-Disposition": 'attachment; filename="icono-whatsapp.png"',
        "Cache-Control": "private, no-store",
      },
    }
  );
}
