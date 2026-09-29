/**
 * La única forma de escribir la clave de un cupo.
 *
 * Dos formas de escribir la misma clave son dos cupos: el login por formulario
 * contaba en `signin:…` y el mismo login por la API en `auth:in:…`, así que un
 * atacante tenía los dos topes enteros. Todas las claves salen de acá.
 *
 * Sin imports a propósito: la usan tests puros y módulos de `src/app` sin
 * arrastrar la cadena de `server-only` de `./index`.
 */
export type AmbitoDeCupo =
  | "user"
  | "auth:in"
  | "auth:up"
  | "auth:reset"
  | "auth:ip"
  | "demo-public"
  | "batch-simulate"
  | "re-analyze"
  | "whatsapp"
  | "core-api";

export function claveDeCupo(ambito: AmbitoDeCupo, ...partes: string[]): string {
  return [ambito, ...partes.map((p) => p.trim().toLowerCase())].join(":");
}
