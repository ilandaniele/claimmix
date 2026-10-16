/**
 * El texto de la persona, listo para entrar a un prompt.
 *
 * AC24: lo que el modelo no ve no lo puede repetir. El orden importa: los
 * enlaces primero, los centinelas al final.
 */

import { sinCentinelas } from "@/core/ai/sin-centinelas";
import { sinEnlaces } from "@/core/mensajes/pregunta";

/**
 * El mensaje de la persona, sin los números que no hay que repetir.
 *
 * `lastMessage` entra al prompt para dar tono, y es el correo que escribió
 * un asegurado: adentro viene su DNI entero, porque se lo pedimos nosotros.
 * Mientras el cuerpo lo armó la plantilla eso no salía a ningún lado — la
 * plantilla enmascara al renderizar. Desde que la prosa del modelo reemplaza
 * el cuerpo, lo que el modelo leyó puede terminar en el mail, y AC24 pasa a
 * depender de que al modelo no se le ocurra copiarlo.
 *
 * Siete a ocho dígitos seguidos es un DNI argentino; los puntos y espacios se
 * aceptan porque así lo escribe la gente. Un año o un monto no llegan a
 * siete, y una patente lleva letras.
 */
export function sinNumerosEnteros(texto: string): string {
  const ultimosCuatro = (m: string): string => {
    const digitos = m.replace(/\D/g, "");
    return digitos.length >= 7 && digitos.length <= 10
      ? "****" + digitos.slice(-4)
      : m;
  };

  return (
    texto
      // Un DNI suelto, con o sin los puntos con que lo escribe la gente.
      .replace(/\b\d[\d.\s]{5,}\d\b/g, ultimosCuatro)
      // Una póliza, que lleva prefijo de letras: POL-2024-001. La patente
      // no entra — ABC-321 no llega a seis dígitos.
      .replace(/\b([A-Za-z]{2,4})-([\d.-]{6,})\b/g, (m, pre: string, resto: string) => {
        const digitos = resto.replace(/\D/g, "");
        return digitos.length >= 6 ? `${pre}-****${digitos.slice(-4)}` : m;
      })
  );
}

/**
 * Una póliza corta, POL-4471-A: `sinNumerosEnteros` pide seis dígitos para no
 * tapar una patente, y ésta pasaba entera. En el ensayo `devolver-al-agente`
 * (15/10) volvió tal cual: «entendemos que la póliza es la POL-4471-A». La
 * patente no llega, ABC-321 tiene tres dígitos. El prefijo queda: con «****»
 * solo, el modelo escribió «entendemos que la patente es la ****».
 */
export function sinPolizasCortas(texto: string): string {
  return texto.replace(/\b([A-Za-z]{2,4})-\d{4,5}(?:-[A-Za-z0-9]+)?\b/g, "$1-****");
}

/**
 * Enlaces, DNI, pólizas y centinelas fuera, en ese orden. Con `polizaCambiada`
 * también cualquier número de tres cifras o más: `sinNumerosEnteros` sólo tapa
 * de 7 a 10 dígitos y «4455» llegaba entero. Los mails no se tapan.
 */
export function paraElPrompt(texto: string, opciones: { polizaCambiada?: boolean } = {}): string {
  const sinNumeros = (t: string): string =>
    opciones.polizaCambiada ? t.replace(/\d{3,}/g, "***") : t;
  return sinCentinelas(sinNumeros(sinPolizasCortas(sinNumerosEnteros(sinEnlaces(texto)))));
}
