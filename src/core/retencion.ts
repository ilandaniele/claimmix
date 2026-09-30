/**
 * Retención de casos y purga de adjuntos: qué está encendido y desde cuándo se
 * borra. Sin base ni reloj propio. Ambos interruptores nacen APAGADOS y cualquier
 * valor que no se entienda también apaga: borrar es lo que no se hace por error.
 */

export type ModoDeBorrado = "apagado" | "simular" | "borrar";

export function leerModo(valor: string | null | undefined): ModoDeBorrado {
  const v = valor?.trim().toLowerCase();
  return v === "simular" || v === "borrar" ? v : "apagado";
}

export const ANIOS_POR_OMISION = 5;
export const GRACIA_POR_OMISION = 30;

export type Retencion = {
  modo: ModoDeBorrado;
  anios: number;
  /** Se borra lo cerrado ANTES de esta fecha. */
  corte: Date;
};

type Entorno = Record<string, string | undefined>;

function entero(valor: string | undefined): number | null {
  if (valor === undefined || valor.trim() === "") return null;
  return /^\d+$/.test(valor.trim()) ? Number(valor.trim()) : Number.NaN;
}

/** Fuera de 1..30 años (o algo que no es un entero) apaga: un typo no puede achicar el plazo. */
export function leerRetencion(env: Entorno, ahora: Date): Retencion {
  const pedido = entero(env.RETENCION_ANIOS);
  const anios = pedido ?? ANIOS_POR_OMISION;
  const valido = Number.isInteger(anios) && anios >= 1 && anios <= 30;
  const corte = new Date(ahora);
  corte.setUTCFullYear(corte.getUTCFullYear() - (valido ? anios : ANIOS_POR_OMISION));
  return {
    modo: valido ? leerModo(env.RETENCION_MODO) : "apagado",
    anios: valido ? anios : ANIOS_POR_OMISION,
    corte,
  };
}

/** Días entre el borrado de un caso y el de sus adjuntos: fuera de 7..365 vuelve a 30. */
export function leerGracia(env: Entorno): number {
  const dias = entero(env.PURGA_GRACIA_DIAS);
  return dias !== null && Number.isInteger(dias) && dias >= 7 && dias <= 365 ? dias : GRACIA_POR_OMISION;
}

/**
 * La hora 4 UTC. El cron diario de Vercel cae ahí, pero el barrido también lo
 * llama GitHub cada 15 minutos: la ventana evita borrar noventa y seis veces por
 * día, pero en esa hora todavía entran unas cinco llamadas. Que corra UNA vez lo
 * decide el cupo `PURGA_Y_RETENCION`, que la ruta pide dentro de la ventana.
 */
export function ventanaDiaria(fecha: Date): boolean {
  return fecha.getUTCHours() === 4;
}
