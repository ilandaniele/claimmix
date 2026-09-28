/** Sufijo del host de la base viva (Neon). Decisión del dueño, 27/09: los e2e no corren ahí nunca. */
export const HOST_DE_PRODUCCION = "ep-proud-resonance";

// Next 16 declara NODE_ENV como obligatoria en NodeJS.ProcessEnv (ver
// node_modules/next/types/global.d.ts); los tests pasan objetos sueltos con
// sólo DATABASE_URL*, así que el tipo va por el mismo idioma que
// src/server/gcp/credenciales.ts.
type Env = Record<string, string | undefined>;

/**
 * Se planta si DATABASE_URL o DATABASE_URL_APP apuntan a producción.
 * Imprime sólo el host: la cadena lleva la contraseña.
 */
export function exigirQueNoSeaProduccion(env: Env = process.env): void {
  for (const nombre of ["DATABASE_URL", "DATABASE_URL_APP"] as const) {
    const valor = env[nombre];
    if (!valor) continue;
    let host: string;
    try {
      host = new URL(valor.replace(/^postgres(ql)?:/, "https:")).host;
    } catch {
      host = "(ilegible)";
    }
    if (host.includes(HOST_DE_PRODUCCION)) {
      throw new Error(`${nombre} apunta a la base de PRODUCCIÓN (${host}). Los e2e no corren ahí.`);
    }
  }
}
