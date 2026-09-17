import "server-only";
import { cache } from "react";

import { filaDeUsuario, type FilaUsuario } from "@/lib/auth/fila-de-usuario-cacheada";

export type UserRow = FilaUsuario;

// `cache()` dedupes per request: layout and page share one query.
export const getUserRow = cache(async (userId: string): Promise<UserRow | null> => {
  try {
    return await filaDeUsuario(userId);
  } catch {
    return null;
  }
});
