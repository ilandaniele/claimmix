import "server-only";
import { cache } from "react";

import { filaDeUsuario, type FilaUsuario } from "@/lib/auth/fila-de-usuario-cacheada";

export type UserRow = FilaUsuario;

// `cache()` dedupes per request: layout and page share one query.
// Distingue "sin fila" (null) de "no se pudo leer" (tira). Sin la distinción,
// una base caída se ve igual que una cuenta sin acceso y manda a /pendiente
// a alguien que sólo tuvo mala suerte con la red.
export const getUserRowOrThrow = cache(
  (userId: string): Promise<UserRow | null> => filaDeUsuario(userId)
);

// Comportamiento sin cambios: una falla se lee como null. Comparte la cache
// por pedido con getUserRowOrThrow, así que entre el layout y una página la
// base la entrega una sola vez.
export const getUserRow = cache(async (userId: string): Promise<UserRow | null> => {
  try {
    return await getUserRowOrThrow(userId);
  } catch {
    return null;
  }
});
