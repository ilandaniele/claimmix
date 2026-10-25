/**
 * El primer instante del mes en curso, con la hora del servidor (UTC en Vercel): desde ahí se suma el
 * gasto mensual y se fecha el aviso de cada tope. No es el mes argentino de `mesArgentino`: el
 * guardia del gasto cuenta así y el aviso tiene que contar con la misma cuenta.
 */
export function inicioDelMes(ahora = new Date()): Date {
  const inicio = new Date(ahora);
  inicio.setDate(1);
  inicio.setHours(0, 0, 0, 0);
  return inicio;
}
