/**
 * Qué día es, acá.
 *
 * El servidor corre en UTC y Buenos Aires está tres horas atrás, así que entre
 * las 21 y las 24 hora local `new Date().toISOString().slice(0, 10)` ya devuelve
 * el día siguiente. Tres horas por día, todos los días — la séptima parte de la
 * jornada, y justo la franja en la que la gente maneja de vuelta a la casa.
 *
 * Dónde importaba:
 *
 * · La vigencia de la póliza. Una con `end_date` de HOY figuraba vencida a las
 *   22:10, así que alguien que chocaba el último día de su cobertura recibía
 *   «tu póliza venció el …» y el caso se derivaba como póliza vencida. Está
 *   cubierto y se le decía que no.
 * · La fecha que se le muestra al modelo en la conversación: «recibido el 28»
 *   para un mensaje que llegó el 27 a la noche.
 * · El nombre del CSV exportado.
 *
 * `en-CA` no es una elección exótica: es el locale que da `AAAA-MM-DD`, que es
 * el formato con el que la base guarda las fechas y con el que se comparan.
 */

/** La zona en la que vive el negocio. */
export const ZONA_ARGENTINA = "America/Argentina/Buenos_Aires";

/**
 * El día de una fecha en la Argentina, como `AAAA-MM-DD`.
 *
 * @param cuando La fecha a mirar. Por omisión, ahora.
 */
export function diaArgentino(cuando: Date = new Date()): string {
  return cuando.toLocaleDateString("en-CA", { timeZone: ZONA_ARGENTINA });
}

/**
 * Cuánto hay que sumarle a la hora de pared argentina para llegar a UTC, en ms.
 *
 * Se mide EN el instante que se pregunta y no de una vez para siempre. Hoy
 * Argentina está fija en UTC-3 —no mueve el reloj desde 2009— y sería más corto
 * escribir un `3` en algún lado, pero eso es una constante que un día deja de
 * ser cierta sin que nada avise. Preguntarle a `Intl` cuesta lo mismo.
 */
function desfasajeArgentino(instante: Date): number {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_ARGENTINA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instante);
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  const comoSiFueraUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return instante.getTime() - comoSiFueraUtc;
}

/** El instante exacto en que empieza un día argentino, en ISO (UTC). */
function medianocheArgentina(anio: number, mes: number, dia: number): string {
  const tentativo = Date.UTC(anio, mes - 1, dia, 0, 0, 0, 0);
  return new Date(tentativo + desfasajeArgentino(new Date(tentativo))).toISOString();
}

/**
 * La ventana del mes corriente, en horario argentino.
 *
 * Las métricas la armaban con `new Date(now.getFullYear(), now.getMonth(), 1)`,
 * que construye la medianoche del primero **en la zona del proceso**. En una
 * máquina argentina eso da bien y en Vercel —que corre en UTC— da las 21:00 del
 * último día del mes anterior: el panel de septiembre venía con las últimas tres
 * horas de agosto adentro, y los siniestros de la primera madrugada de
 * septiembre contados en el mes equivocado.
 *
 * Es el peor tipo de error: correcto en la máquina de quien lo escribe,
 * incorrecto en la única máquina que le importa a alguien, y sin forma de
 * reproducirlo localmente. Por eso la zona va dicha y no heredada.
 *
 * `fin` es el arranque del mes siguiente, o sea exclusivo — como lo usan las
 * consultas, que hacen `gte(inicio)` y `lt(fin)`.
 */
export function mesArgentino(cuando: Date = new Date()): {
  inicio: string;
  fin: string;
} {
  const [anio, mes] = diaArgentino(cuando).split("-").map(Number);
  return {
    inicio: medianocheArgentina(anio, mes, 1),
    // Mes 13 lo resuelve `Date.UTC` solo: pasa a enero del año siguiente.
    fin: medianocheArgentina(anio, mes + 1, 1),
  };
}

/** El nombre del mes corriente en la Argentina, para encabezados. */
export function nombreDelMesArgentino(cuando: Date = new Date()): string {
  return cuando.toLocaleDateString("es-AR", {
    timeZone: ZONA_ARGENTINA,
    month: "long",
    year: "numeric",
  });
}
