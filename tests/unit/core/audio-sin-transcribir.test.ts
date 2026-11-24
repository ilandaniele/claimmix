/**
 * Lo que se le dice a quien mandó una nota de voz que no se pudo escuchar.
 *
 * La guarda del redactor deja pasar sólo un texto que dice que el audio no se
 * escuchó y pide escribirlo o mandarlo de nuevo. Acá quedan afirmadas las dos
 * puntas: las paráfrasis buenas no gastan un reintento, y las que dan el audio
 * por anotado, recibido o escuchado no llegan a la persona.
 */

import { describe, it, expect } from "vitest";

import { AUDIO_SIN_TRANSCRIBIR, diceQueNoSeEscucho } from "@/core/mensajes/audio-sin-transcribir";

describe("diceQueNoSeEscucho", () => {
  it("acepta el piso", () => {
    expect(diceQueNoSeEscucho(AUDIO_SIN_TRANSCRIBIR)).toBe(true);
  });

  it.each([
    "Lucía, no pudimos escuchar tu nota de voz. ¿Nos lo podés contar por escrito?",
    "No pudimos escuchar tu mensaje de voz, ¿nos lo escribís?",
    "No se pudo escuchar el audio. ¿Podrías volver a enviarlo?",
    "No pudimos entender tu audio. ¿Nos contás por mensaje lo que pasó?",
    "No se escuchó bien tu nota de voz, escribinos lo que querías contar.",
    "No llegamos a escuchar tus audios. ¿Los mandás otra vez?",
    // Con el pronombre antes del verbo, con otro verbo o pidiéndolo de otra forma.
    "Recibimos tu nota de voz, pero no la pudimos escuchar bien. ¿Nos escribís lo que querías contarnos?",
    "Tu audio no lo pudimos escuchar. ¿Nos lo escribís?",
    "Tu nota de voz no la escuchamos bien. ¿Nos la escribís?",
    "No conseguimos escuchar tu nota de voz. ¿Nos la mandás de nuevo?",
    "Tu nota de voz no se llegó a escuchar. ¿Nos lo contás por acá?",
    "Lucía, no pudimos escuchar tu audio. ¿Nos lo mandás de vuelta?",
    "No pudimos entender tu audio. ¿Nos lo contás por texto?",
    "No se entiende bien tu audio. ¿Nos lo escribís?",
    // «así la escuchamos» es lo que va a pasar, no lo que pasó.
    "No pudimos escuchar tu nota de voz. Mandala de nuevo así la escuchamos.",
    // Lo mismo después de un pedido y una «y», y «lo que nos dijiste» como lo que se pide.
    "No pudimos escuchar tu nota de voz. Escribinos lo que querías contar y lo sumamos al reclamo.",
    "No pudimos escuchar tu audio. Contanos por escrito y lo agregamos a tu reclamo.",
    "No pudimos escuchar tu nota de voz. ¿Nos la mandás de nuevo y la escuchamos?",
    "No pudimos escuchar tu nota de voz. ¿Nos lo escribís así lo anotamos?",
    "No pudimos escuchar tu audio. ¿Nos escribís lo que nos contaste en el audio?",
    "No pudimos escuchar tu audio. ¿Nos escribís lo que nos dijiste?",
    // «todo» lejos del audio, o «algo» que no es un pedazo, no dicen que se escuchó una parte.
    "Tu nota de voz no se escucha porque se corta todo el tiempo. ¿Nos la mandás de nuevo?",
    "Tu audio no se entiende porque es todo ruido. ¿Nos lo escribís?",
    "Tu audio llegó con algo de ruido y no se entendió. ¿Nos lo escribís?",
    "No pudimos escuchar tu último audio. ¿Nos lo escribís?",
    // Hablándole a la persona, o pidiendo otra nota.
    "Lucía, no te escuchamos bien en el audio. ¿Nos lo escribís?",
    "Lucía, no te pudimos escuchar bien en la nota de voz. ¿Nos escribís lo que querías contar?",
    "No se te escucha bien en el audio. ¿Nos lo escribís?",
    "No se te entiende en la nota de voz. ¿Nos la mandás de nuevo?",
    "No te entendimos bien el audio, Lucía. Escribinos lo que nos querías contar.",
    "No pudimos escuchar tu nota de voz. ¿Nos mandás otro audio?",
    "No pudimos escuchar tu nota de voz. ¿Podés grabar otra?",
    "No pudimos escuchar tu nota de voz. ¿Nos lo mandás en un mensaje?",
  ])("acepta la paráfrasis: %s", (texto) => {
    expect(diceQueNoSeEscucho(texto)).toBe(true);
  });

  it.each([
    // El texto del ensayo.
    "Lucía, ya tomamos nota de lo que nos contaste en el audio.",
    // Lo dan por anotado o recibido sin decir que no se escuchó.
    "Lucía, tu audio quedó registrado. Si querés agregar algo, escribinos.",
    "Ya quedó anotado lo de tu audio. Cualquier cosa, escribinos.",
    "Recibimos lo que nos contaste en el audio, cualquier cosa escribinos.",
    "Gracias por el audio, lo vamos a revisar; si querés, escribinos.",
    "Ya tenemos lo que nos contaste en el audio. Si falta algo, escribinos.",
    "Lucía, recibimos lo que nos contaste en el audio. Cualquier cosa, escribinos.",
    "Lucía, gracias otra vez por el audio, ya sabemos lo que pasó.",
    "Lucía, gracias por la nota de voz, ya la escuchamos. Si querés sumar algo, escribinos.",
    // Dicen que no se escuchó y lo dan por anotado, escuchado o sumado a la vez.
    "No pudimos escuchar tu audio, pero tomamos nota de lo que nos contaste. Escribinos.",
    "Escuchamos tu nota de voz y ya la sumamos al reclamo; una parte no se entendió, ¿nos la escribís?",
    "Recibimos lo que nos dijiste en el audio, pero una parte no se escuchó bien: ¿nos la escribís?",
    "Lucía, escuchamos tu audio pero no se entendió bien. ¿Nos lo escribís?",
    "Lucía, ya la escuchamos, pero no se entendió bien tu nota de voz. ¿Nos la escribís?",
    "No pudimos escuchar bien tu audio, pero ya lo sumamos al reclamo. ¿Nos escribís lo que falta?",
    "Tu audio quedó agregado al caso, aunque no se escuchó bien. ¿Nos lo escribís?",
    "Lucía, entendimos tu audio pero no se entendió bien. ¿Nos lo escribís?",
    "Pudimos escuchar parte de tu audio, pero no se entendió la patente. ¿Nos la escribís?",
    "Tu audio se escuchó bien, salvo la patente, que no se entendió. ¿Nos la escribís?",
    "Revisamos tu nota de voz, pero no se entendió bien la fecha. ¿Nos la escribís?",
    "Si bien escuchamos tu nota de voz, no se entendió bien. ¿Nos la escribís?",
    "Cuando escuchamos tu audio, no se entendió bien la patente. ¿Nos la escribís?",
    "Ya oí tu audio, pero no se entendió la patente. ¿Nos la escribís?",
    "No pudimos escuchar tu audio, pero lo que nos dijiste ya está en el reclamo. Escribinos si falta algo.",
    // Dicen que no se escuchó una parte: el resto se daría por escuchado.
    "Algo de tu nota de voz no se escuchó. ¿Nos lo escribís?",
    "Una parte del audio no se entendió. ¿Nos la escribís?",
    "No pudimos escuchar tu audio completo. ¿Nos escribís lo que falta?",
    "Tu nota de voz no se escuchó del todo bien. ¿Nos la mandás de nuevo?",
    "Tu nota de voz se escuchó a medias y no pudimos entender el final. ¿Nos lo escribís?",
    "No pudimos escuchar el resto de tu audio. ¿Nos lo escribís?",
    "Tu audio se cortó y no pudimos escuchar el resto. ¿Nos lo escribís?",
    "Tu nota de voz se cortó a la mitad y no pudimos escuchar el resto. ¿Nos lo escribís?",
    "No pudimos escuchar el principio de tu nota de voz. ¿Nos lo escribís?",
    "No pudimos escuchar bien lo último de tu audio. ¿Nos lo escribís?",
    "Hubo un tramo de tu audio que no pudimos escuchar. ¿Nos lo escribís?",
    // No nombran el audio, o no piden escribirlo.
    "No pudimos escuchar lo que nos mandaste. ¿Nos escribís?",
    "No pudimos escuchar tu nota de voz.",
  ])("rechaza: %s", (texto) => {
    expect(diceQueNoSeEscucho(texto)).toBe(false);
  });
});
