/**
 * Código de error que se puede loguear sin arrastrar datos de nadie.
 *
 * Un mismo texto de tres líneas vivía copiado en el módulo: el código nativo
 * del error si lo tiene (por ejemplo el de Postgres), y si no, el nombre de la
 * clase de `Error`. Sin ninguno de los dos, `"UnknownError"`.
 */
export function errorCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}
