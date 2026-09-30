/**
 * Lo que un texto dirigido al asegurado no puede decir sobre la culpa (B18).
 *
 * La opinión de responsabilidad es del equipo y es orientativa: si una
 * respuesta del agente nombra la culpa o cita la ley de tránsito, está
 * adelantando esa opinión. Sin un patrón por `responsab`: choca con
 * «responsabilidad civil», que es el nombre legítimo de un tipo de siniestro.
 *
 * Dos cuidados con lo que se parece a la ley sin serlo. Un número de artículo
 * pelado son uno o dos dígitos (la ley no llega a cien): «ART 123» o «art123»
 * son una patente vieja. Y «24.449» sólo es la ley si no es el comienzo o el
 * final de un número más largo, como el DNI «24.449.882».
 */

export const NOMBRA_CULPA_O_LEY: readonly RegExp[] = [
  /\bculpa(?:ble)?s?\b/i,
  /(?<!\d\.?)24\.?449(?!\d|\.\d)/,
  /\bart(?:[íi]culos?|\.)\s*\d/i,
  /\bart\s*\d{1,2}\b/i,
];

export function nombraCulpaOLey(texto: string): boolean {
  return NOMBRA_CULPA_O_LEY.some((re) => re.test(texto));
}
