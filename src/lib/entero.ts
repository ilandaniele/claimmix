/** El entero escrito, o null si no es un entero con dígitos dentro de [min, max]. */
export function enteroDe(crudo: string | undefined, min: number, max: number): number | null {
  const t = crudo?.trim();
  if (!t || !/^-?\d+$/.test(t)) return null;
  const valor = Number(t);
  return Number.isSafeInteger(valor) && valor >= min && valor <= max ? valor : null;
}
