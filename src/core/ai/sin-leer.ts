/** Por qué un documento no se leyó (B6, B21). La pantalla lo dice; nunca inventa una lectura. */
export const MOTIVOS_SIN_LEER = ["mock", "presupuesto", "cupo", "archivo", "paginas", "modelo", "formato"] as const;

export type MotivoSinLeer = (typeof MOTIVOS_SIN_LEER)[number];

export function esMotivoSinLeer(m: unknown): m is MotivoSinLeer {
  return (MOTIVOS_SIN_LEER as readonly unknown[]).includes(m);
}
