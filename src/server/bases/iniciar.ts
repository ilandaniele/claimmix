/**
 * Arranca la preparación de la base de un inquilino.
 *
 * Deja la fila en `creando` ANTES de lanzar el workflow: si el lanzamiento falla,
 * la persona igual ve «preparando» (y el botón de reintentar, pasado el plazo) en
 * vez de un espacio sin fila que el layout no sabría explicar. Apagada la bandera
 * `BASE_POR_CLIENTE` no hace nada: hay una sola base y ya está lista.
 */

import "server-only";

import { start } from "workflow/api";

import { basePorCliente } from "@/data/bases";
import { prepararBase } from "@/workflows/preparar-base";

import { registrarBase } from "./crear-base";

export async function iniciarBase(tenantId: string): Promise<void> {
  if (!basePorCliente()) return;
  await registrarBase(tenantId);
  await start(prepararBase, [tenantId]);
}
