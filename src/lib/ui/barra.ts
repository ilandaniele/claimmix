import "server-only";

import { cookies } from "next/headers";

import { BARRA_COOKIE } from "./barra-shared";

/** Sólo el «1» contrae: una cookie rota o ausente deja la barra abierta. */
export async function leerBarraContraida(): Promise<boolean> {
  return (await cookies()).get(BARRA_COOKIE)?.value === "1";
}
