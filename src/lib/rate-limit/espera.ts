/**
 * Cuánto esperar, como mucho, cuando el contador de cupos no contestó: el aviso
 * es «probá en un rato», no «mañana». Sin imports a propósito: lo leen `./index`
 * y las pantallas que distinguen un 429 pasajero de un cupo agotado.
 */
export const REINTENTO_SIN_CONTADOR_MS = 60_000;
