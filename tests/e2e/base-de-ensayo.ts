/** Sufijo del host de la base viva (Neon). Decisión del dueño, 27/09: los e2e no corren ahí nunca. */
export const HOST_DE_PRODUCCION = "ep-proud-resonance";

// Next 16 declara NODE_ENV como obligatoria en NodeJS.ProcessEnv (ver
// node_modules/next/types/global.d.ts); los tests pasan objetos sueltos con
// sólo DATABASE_URL*, así que el tipo va por el mismo idioma que
// src/server/gcp/credenciales.ts.
type Env = Record<string, string | undefined>;

/**
 * Host de una cadena de Postgres, en minúsculas y con el `?host=` que el driver de
 * Neon prefiere al de la URL. "" si la cadena no se lee.
 */
export function hostDe(cadena: string | undefined): string {
  try {
    const u = new URL((cadena ?? "").trim().replace(/^postgres(ql)?:/i, "https:"));
    return [u.host, u.searchParams.get("host") ?? ""].join(" ").trim().toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Código del error del driver, de su `cause` o del `error` que trae el ErrorEvent
 * del WebSocket; si no hay, la clase del error.
 */
export function codigoDe(e: unknown): string {
  const x = e as { code?: string; cause?: { code?: string }; error?: { code?: string } };
  return x?.code ?? x?.cause?.code ?? x?.error?.code ?? (e instanceof Error ? e.name : "error");
}

/**
 * Código y primera línea del mensaje, con las URLs tapadas. Lo que sigue (los
 * parámetros de drizzle, el `detail` del servidor) no sale.
 */
export function resumenDe(e: unknown): string {
  const msg = (e as { message?: unknown })?.message;
  // El ErrorEvent del WebSocket llega sin mensaje: queda al menos su clase.
  const texto = typeof msg === "string" && msg ? msg : e instanceof Object ? e.constructor.name : String(e);
  const primera = texto.split("\n")[0];
  return `${codigoDe(e)}: ${primera.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, "<url>").slice(0, 200)}`;
}

/**
 * En GitHub Actions tapa cada valor en el log del job. El runner decodifica `%25`,
 * `%0D` y `%0A` en el dato del comando: sin escaparlos, un nombre con `%0A` tapa
 * otra cosa.
 */
export function taparEnElLog(valores: Array<string | null | undefined>): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  for (const v of valores) {
    if (v) console.log(`::add-mask::${v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
  }
}

/**
 * Se planta si DATABASE_URL o DATABASE_URL_APP apuntan a producción.
 * Imprime sólo el host: la cadena lleva la contraseña.
 */
export function exigirQueNoSeaProduccion(env: Env = process.env): void {
  for (const nombre of ["DATABASE_URL", "DATABASE_URL_APP"] as const) {
    const valor = env[nombre];
    if (!valor) continue;
    const host = hostDe(valor) || "(ilegible)";
    if (host.includes(HOST_DE_PRODUCCION)) {
      throw new Error(`${nombre} apunta a la base de PRODUCCIÓN (${host}). Los e2e no corren ahí.`);
    }
  }
}
