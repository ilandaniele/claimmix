/**
 * Las tres baldosas de arriba de la bandeja cuentan los estados reales.
 *
 * Estaban escritas a mano en la pantalla contra el vocabulario VIEJO, el del
 * flujo simulado: `escalado` sin `requiere_especialista`, y `listo` sin
 * `listo_para_core` ni `enviado_a_core`, que es donde termina todo caso
 * completado por mail o por WhatsApp.
 *
 * Es el mismo defecto que el repo ya encontró y arregló en las métricas,
 * sobreviviendo en la pantalla que se mira todo el día: con 43 casos en
 * `requiere_especialista` la baldosa «Escalados» decía 0 y aclaraba «Ninguno
 * abierto». Un incendio con heridos derivado a las 3 AM no sumaba en el
 * indicador que existe para decir «esto necesita a alguien». Y las pestañas de
 * abajo sí muestran los trece estados, así que la pantalla se contradecía
 * consigo misma.
 */

import { describe, expect, it } from "vitest";

import { kpisDeLaBandeja } from "@/core/case/kpis-de-la-bandeja";
/*
 * Import estatico, no `await import()` adentro del caso.
 *
 * Con el dinamico este archivo fallaba de a ratos —una vez de cada tres, sin
 * tocar nada— porque resolvia el modulo mientras otro archivo de tests estaba
 * mockeando su grafo. `nombresEnElLibro` es una funcion pura sobre una tabla
 * constante: no tiene forma de dar dos resultados distintos, asi que el
 * problema nunca estuvo en lo que se prueba sino en cuando se carga.
 *
 * `server-only` no molesta: vitest.config lo aliasea a un stub para todos.
 */
import { nombresEnElLibro } from "@/server/confirmations/messenger";

describe("kpisDeLaBandeja", () => {
  it("cuenta como escalado lo que el canal real escribe", () => {
    // `requiere_especialista` es el del camino de producción; `escalado`, el
    // del simulado. Contar sólo el segundo era el defecto.
    const kpis = kpisDeLaBandeja([
      { status: "requiere_especialista", count: 43 },
      { status: "escalado", count: 2 },
    ]);

    expect(kpis.escalados).toBe(45);
  });

  it("cuenta como resuelto lo que termina en el core", () => {
    // Donde termina todo caso completado por mail o por WhatsApp.
    const kpis = kpisDeLaBandeja([
      { status: "listo", count: 5 },
      { status: "listo_para_core", count: 28 },
      { status: "enviado_a_core", count: 3 },
      { status: "cerrado", count: 7 },
    ]);

    expect(kpis.resueltos).toBe(43);
  });

  it("«esperando» es la espera del denunciante, no la nuestra", () => {
    // `confirmacion_pendiente` NO entra aunque el nombre invite: ahí la espera
    // es de un analista que tiene que confirmar un campo. Contar las dos bajo
    // un rótulo que promete una es cómo se arruina un tablero.
    const kpis = kpisDeLaBandeja([
      { status: "esperando", count: 4 },
      { status: "info_faltante", count: 11 },
      { status: "confirmacion_pendiente", count: 9 },
    ]);

    expect(kpis.esperando).toBe(15);
  });

  it("`no_relevante` no es un caso resuelto", () => {
    // Es el balde más grande de la base y no son denuncias resueltas sino
    // mensajes que no eran denuncias. Sumarlos haría que «Listos» fuera la
    // mayoría del tablero sin que nadie hubiera resuelto nada.
    const kpis = kpisDeLaBandeja([
      { status: "no_relevante", count: 329 },
      { status: "listo", count: 1 },
    ]);

    expect(kpis.resueltos).toBe(1);
  });

  it("un estado que no vino del GROUP BY cuenta 0 y no rompe", () => {
    expect(kpisDeLaBandeja([])).toEqual({ escalados: 0, esperando: 0, resueltos: 0 });
  });
});

/**
 * Y la guarda del cierre, que preguntaba por un solo nombre.
 *
 * El libro no guarda el mismo nombre para los dos canales: el mail escribe
 * `confirmation_received` y WhatsApp `wa_confirmation_received`. La consulta
 * que hace cumplir «mandalo siempre, pero una sola vez» preguntaba sólo por el
 * del mail, así que devolvía 0 filas para todo caso de WhatsApp: un analista
 * toca «Re-analizar» sobre un caso ya completo y al asegurado le llega por
 * segunda vez el mensaje de que su denuncia está lista.
 */
describe("nombresEnElLibro", () => {
  it("trae los dos nombres de una plantilla que WhatsApp renombra", () => {
    expect(nombresEnElLibro("confirmation_received")).toEqual(
      expect.arrayContaining(["confirmation_received", "wa_confirmation_received"])
    );
  });

  it("y uno solo cuando no hay renombre, sin duplicarlo", () => {
    // La derivación sale del mapa que usa `recordOutbound`: si un canal nuevo
    // agrega su prefijo, queda cubierto sin tocar la guarda.
    const nombres = nombresEnElLibro("confirmation_received");
    expect(new Set(nombres).size).toBe(nombres.length);
  });
});
