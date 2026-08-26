/**
 * Un flujo de tres pasos que existe sólo para probar que la durabilidad es real.
 *
 * La pregunta que responde: cuando un paso falla y el flujo se reanuda, ¿vuelve
 * a correr lo que ya se había hecho?
 *
 * Importa porque en este producto el paso caro llama al modelo y le escribe a
 * un damnificado. Repetirlo no es cómputo desperdiciado: es un segundo mail a
 * la misma persona.
 *
 * **Por qué anota en un archivo y no en una variable.** El primer intento usaba
 * un contador a nivel de módulo y daba cero siempre. Los pasos no corren en el
 * mismo módulo que el test: el SDK los compila a un paquete aparte y los
 * ejecuta en su propio contexto. La variable que el test miraba y la que los
 * pasos incrementaban eran dos con el mismo nombre — un cero que parece "no se
 * ejecutó" cuando en realidad es "no lo estás mirando". El disco cruza ese
 * borde, y además es lo que sobrevive a que el proceso muera, que es justo lo
 * que acá se quiere medir.
 */
import { anotar, leerBitacora } from "./_prueba-bitacora";

export interface Entrada {
  readonly archivo: string;
  /** Cuántas veces tiene que fallar el paso del medio antes de dejarlo pasar. */
  readonly fallas: number;
}

async function pasoUno(entrada: Entrada): Promise<string> {
  "use step";
  anotar(entrada.archivo, "uno");
  return "uno";
}

async function pasoDos(entrada: Entrada): Promise<string> {
  "use step";
  anotar(entrada.archivo, "dos");

  // Se cuenta sobre el archivo y no sobre un contador en memoria, por lo mismo
  // de arriba: cada reintento puede correr en otro contexto.
  const intentos = leerBitacora(entrada.archivo).filter((l) => l === "dos").length;
  if (intentos <= entrada.fallas) {
    // Un error común, no fatal: el runtime lo reintenta. Un `FatalError`
    // cortaría el flujo, que es lo contrario de lo que se quiere medir.
    throw new Error("falla a propósito");
  }
  return "dos";
}

async function pasoTres(entrada: Entrada): Promise<string> {
  "use step";
  anotar(entrada.archivo, "tres");
  return "tres";
}

export async function tresPasos(entrada: Entrada): Promise<string> {
  "use workflow";

  const a = await pasoUno(entrada);
  const b = await pasoDos(entrada);
  const c = await pasoTres(entrada);
  return `${a}-${b}-${c}`;
}
