/** Un parámetro de la URL que puede venir repetido: vale el último, que es el que agregó quien más cerca estuvo del fallo. */
export function ultimoValor(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor.at(-1) : valor;
}
