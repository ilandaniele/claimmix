/**
 * POST /api/auth/salir — «Cerrar sesión» de las tarjetas de antes del panel (/alta,
 * /conectar-whatsapp, /preparando).
 *
 * Es un formulario que se envía como navegación de documento y no una Server Action
 * con `redirect()`: ése es un salto del lado del cliente, y /login heredaba el CSP de
 * /conectar-whatsapp con el SDK de Facebook todavía cargado en la página. Acá el
 * navegador pide /login de cero, con su propio CSP, y además anda sin JavaScript.
 *
 * Sin chequeo de origen: la cookie de sesión es SameSite=Lax y un POST desde otro sitio
 * no la lleva, así que no hay sesión que cerrar. Se contesta 303 para que el navegador
 * pida /login con GET.
 */

import { NextResponse } from "next/server";

import { cerrarSesion } from "@/lib/auth/cerrar-sesion";

export async function POST(): Promise<NextResponse> {
  await cerrarSesion();
  return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
}
