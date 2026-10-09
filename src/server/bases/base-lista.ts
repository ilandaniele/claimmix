/**
 * ¿Ya tiene su base lista quien tiene la sesión?
 *
 * Apagada la bandera hay una sola base y la respuesta es sí, sin consultar nada.
 * Prendida, lee la fila sin la copia en memoria: se pregunta justo en el momento
 * en que el estado puede haber cambiado (conectar Gmail, mandar el código del
 * número) y una copia de 30 s mandaría a /preparando a quien ya puede pasar.
 * Sin fila de `tenant_bases` no está lista, igual que en el layout de `(app)`.
 */

import "server-only";

import { basePorCliente } from "@/data/bases";
import { filaDeUsuario, olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";

export async function baseLista(userId: string): Promise<boolean> {
  if (!basePorCliente()) return true;
  olvidarFilaDeUsuario(userId);
  const fila = await filaDeUsuario(userId);
  return fila?.base === "lista";
}
