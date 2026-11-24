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
    // Dicen que no se escuchó y lo dan por anotado a la vez.
    "No pudimos escuchar tu audio, pero tomamos nota de lo que nos contaste. Escribinos.",
    // No nombran el audio, o no piden escribirlo.
    "No pudimos escuchar lo que nos mandaste. ¿Nos escribís?",
    "No pudimos escuchar tu nota de voz.",
  ])("rechaza: %s", (texto) => {
    expect(diceQueNoSeEscucho(texto)).toBe(false);
  });
});
