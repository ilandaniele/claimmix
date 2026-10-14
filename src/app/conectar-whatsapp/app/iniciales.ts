/** Hasta dos iniciales (letras o números) de las primeras palabras del nombre; «CM» si no hay ninguna. */
export function inicialesDe(nombre: string): string {
  const letras = nombre
    .split(/\s+/)
    .map((palabra) => palabra.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return letras ? letras.toLocaleUpperCase("es-AR") : "CM";
}
