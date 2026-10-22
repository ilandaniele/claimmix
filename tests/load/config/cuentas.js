/**
 * Las cuentas y los espacios de la prueba de las aseguradoras.
 *
 * Un solo lugar para los nombres, porque los usan dos programas que no se
 * hablan: `scripts/sembrar-para-integracion.mts --carga`, que las crea, y el
 * escenario de k6, que entra con ellas. Sin globales de k6 ni `__ENV`.
 *
 * Direcciones `example.com`, reservadas: no son de nadie y el despachador se
 * niega a escribirles. La contraseña no está acá ni en ningún archivo: sale de
 * `CARGA_PASSWORD` en el entorno de quien siembra y de quien mide.
 */

/** Lo que se siembra y se mide si nadie lo cambia: 20 aseguradoras de 35 personas. */
export const ASEGURADORAS_POR_OMISION = 20;
export const USUARIOS_POR_OMISION = 35;

const dos = (n) => String(n).padStart(2, "0");

/** Aseguradora y usuario cuentan desde 1. */
export function correoDe(aseguradora, usuario) {
  return `carga-a${dos(aseguradora)}-u${dos(usuario)}@example.com`;
}

/** El id del espacio. Fijo, para que sembrar dos veces no deje otros veinte. */
export function inquilinoDe(aseguradora) {
  return `20000000-0000-4000-8000-${String(aseguradora).padStart(12, "0")}`;
}

/** Quién es el VU número `vu` (desde 1): siempre la misma cuenta, de corrida en corrida. */
export function cuentaDeVu(vu, usuariosPorAseguradora) {
  const i = vu - 1;
  const aseguradora = Math.floor(i / usuariosPorAseguradora) + 1;
  const usuario = (i % usuariosPorAseguradora) + 1;
  return { aseguradora, usuario, correo: correoDe(aseguradora, usuario) };
}

/**
 * Lo que se siembra en cada espacio, y de lo que después tiran los filtros.
 * Las tres listas se reparten con módulos distintos para que las combinaciones
 * (tipo × estado × canal) no queden atadas entre sí.
 */
export const TIPOS = ["choque", "robo", "granizo", "incendio", "cristales", "rc"];
export const ESTADOS = ["procesando", "info_faltante", "listo", "escalado", "cerrado"];
export const CANALES = ["email_sim", "whatsapp_sim"];
export const APELLIDOS = ["Gomez", "Lopez", "Diaz", "Perez", "Sosa", "Vidal", "Duarte", "Bianchi"];

/** Casos por espacio. Alcanzan para paginar a 25 y para que cada filtro devuelva filas. */
export const CASOS_POR_ASEGURADORA = 60;
