/**
 * scripts/rehearse-conversations.ts
 *
 * Drive whole claims through the real agent, end to end, without messaging a
 * single person.
 *
 * Every check so far has been a human typing into WhatsApp and reading what
 * came back. That found real bugs — the photo nobody wrote down, the question
 * asked three times — but it costs a person an afternoon per round, only ever
 * covers the path that person happens to walk, and every message goes out over
 * a WhatsApp Business account that can be flagged for talking to made-up
 * numbers.
 *
 * This runs the same code on the same database with the same model, on the
 * simulated channels. On both channels the messenger composes the reply exactly
 * as it would; WhatsApp records it instead of sending, and email does the same
 * for any `@example.com` address. Nothing reaches a phone or an inbox.
 *
 * Both channels matter and they are genuinely different code: email threads by
 * subject and header, runs a prefilter that decides a message is a newsletter,
 * strips the quoted copy of our own mail out of a reply, and wraps the written
 * prose in HTML. None of that exists on WhatsApp, and all of it has broken.
 * The writer itself is now shared, so what the transcript prints for an email
 * is what a claimant reads — not the deterministic template it used to be.
 *
 * It is a rehearsal, not a unit test. It spends real tokens and writes real
 * rows, and it is the only thing here that can catch a regression in the
 * behaviour that emerges from extraction, gap analysis, the orchestrator and
 * the writer all running together — which is where every bug this week lived.
 *
 * Usage:
 *   pnpm rehearse                  # every scenario
 *   pnpm rehearse choque-completo  # one, by id
 *   pnpm rehearse --keep           # leave the cases in the database to inspect
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";
import { readable } from "@/core/email/texto-legible";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import { diceCuidado } from "@/core/mensajes/derivacion";
import { mencionaElTraspaso } from "@/core/mensajes/traspaso";
import { esPlanPro } from "@/core/billing/plan-pro";
import { policyTypeDeRamo } from "@/core/case/ramos";
import { PLACEHOLDER_AUDIO } from "@/core/adjuntos/transcripcion";
import { MAX_ATTACHMENT_SIZE_BYTES } from "@/core/adjuntos/firma";
import { AppError } from "@/lib/errors";
import { errorCode } from "@/lib/observability/error-code";
import type { PatchActor } from "@/server/cases/patch";
import type { TipoMensajeTardio } from "@/core/case/mensaje-tardio";
import { proponeSinHeridos } from "./lib/propone-sin-heridos.mjs";
import { pideAlgo } from "./lib/pide-algo.mjs";
import { confirmaLoDicho, formaDePedirLaHora } from "./lib/ensayo-confirmaciones.mjs";

const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: fs.existsSync(envPath) ? envPath : undefined });

const TENANT_ID = process.env.GMAIL_TENANT_ID;
if (!process.env.DATABASE_URL || !TENANT_ID) {
  console.error("Faltan DATABASE_URL o GMAIL_TENANT_ID en .env.local");
  process.exit(1);
}

// Imported after dotenv: the db module reads DATABASE_URL at import time.
const { createWhatsAppIntakeAndRunAgent } = await import("@/server/agents/intake-agent");
const { ingestInboundEmail } = await import("@/server/email/inbound-email");
const { runIntakeAgent } = await import("@/server/agents/intake-agent");
const { recordarCaso } = await import("@/server/confirmations/recordatorios");
const { hablaDeHeridos, respuestaAHeridos } = await import("@/core/case/heridos-supuestos");
const { db } = await import("@/lib/db");
const { CONTACT_DOC_KEYS } = await import("@/server/cases/documents");
const {
  cases,
  claimAttachments,
  claimFieldConfirmations,
  claimMessages,
  customers,
  insuredAssets,
  missingDocs,
  outboundMessages,
  extractedFields,
  policies,
  users,
  tenants,
} = await import("@/lib/db/schema");
const { and, eq, asc, inArray, isNotNull, isNull, like, lt, or, sql } = await import("drizzle-orm");

// ── What a rehearsal looks like ──────────────────────────────────────────────

/**
 * One thing the claimant says, and what should be true once the agent has
 * finished thinking about it.
 *
 * Everything in `expect` is optional. A turn with no expectations still runs —
 * useful for setting a conversation up — and the transcript is printed either
 * way, because a reply that is technically correct and reads badly is a
 * failure this file cannot see but a person reading the output can.
 */
interface TurnDicho {
  say: string;
  /**
   * Attach a file.
   *
   * The bytes are a real, tiny JPEG, so the storage path is genuinely
   * exercised: downloaded (skipped — we already have them), validated,
   * uploaded to R2, and written to claim_attachments. That whole chain broke
   * silently once and nobody noticed for weeks.
   *
   * What it cannot rehearse is recognition. Deciding that a photo shows a
   * crumpled bumper means looking at a photo of a crumpled bumper, and a
   * placeholder is not one. Drop a real `tests/fixtures/<name>.jpg` in and it
   * will be used; otherwise the request stays open, which is the correct
   * behaviour for an image nobody can identify.
   */
  photo?: string | boolean;
  /**
   * Un archivo que no es foto: una nota de voz o un PDF, por WhatsApp.
   *
   * `fixture` es el nombre en `tests/fixtures/`, con extensión. Si no está en
   * disco se manda `reemplazo`, que sí está en el repositorio: ejercita el
   * guardado, la firma y la llamada al modelo, pero no lo que el archivo dice.
   */
  adjunto?: { fixture: string; tipo: string; reemplazo?: string };
  /**
   * Una foto que pasa el tope de tamaño, por WhatsApp: ceros en memoria, sin
   * fixture. La fila queda rechazada por "size_exceeded" y nada sube a R2.
   */
  pesado?: boolean;
  /**
   * El asunto, cuando el que inventa el ensayo no sirve.
   *
   * Por omisión todos los mails del ensayo entran con el asunto «Denuncia de
   * siniestro», que es cómodo para las conversaciones y arruina el único
   * escenario que prueba lo contrario: «siniestro» es señal de siniestro para
   * el filtro de entrada, así que el newsletter pasaba de largo, llegaba al
   * modelo y gastaba diez mil tokens en decir que no era un reclamo. El
   * escenario decía probar que el filtro lo frena «antes de gastar un solo
   * token», y lo que probaba era lo contrario sin que nadie lo notara.
   *
   * En un turno que no es el primero, un asunto propio también hace que el mail
   * conteste a su mail anterior (In-Reply-To): entra por el hilo del proveedor y
   * no por el «caso #» del asunto.
   */
  subject?: string;
  /**
   * Las cabeceras del mensaje.
   *
   * Un newsletter de verdad trae `List-Unsubscribe`, y el filtro lo mira. Sin
   * ellas, el fixture no se parece a lo que dice estar imitando.
   */
  headers?: Array<{ name: string; value: string }>;
  expect?: {
    /** The reply must mention each of these, case-insensitively. */
    mentions?: string[];
    /** The reply must not mention any of these. */
    avoids?: string[];
    /** How many attachment rows the case should hold by now. */
    attachments?: number;
    /**
     * Document keys the arriving file should have closed.
     *
     * Only checked when a real photograph is on disk. With the placeholder the
     * recogniser correctly identifies nothing, so asserting a match would be
     * asserting a bug.
     */
    recognises?: string[];
    /**
     * Document keys that must NOT have been closed.
     *
     * The direction of caution that matters: a file wrongly marked as received
     * vanishes from the analyst's list and nobody finds out until the claim
     * stalls. Checked whatever fixture is present — an unrecognisable image
     * must close nothing either.
     */
    recognisesNothing?: boolean;
    /** Exactly how many messages this turn should produce. 0 means silence. */
    replies?: number;
    /**
     * Que el filtro de entrada lo haya frenado antes de gastar un token.
     *
     * `replies: 0` no alcanza para esto, y por eso existe. Dos caminos muy
     * distintos producen cero respuestas: que el filtro lo descarte —lo
     * correcto— y que NO lo descarte, abra una denuncia en la bandeja del
     * analista, y encima el agente se quede callado. El segundo es el fallo que
     * este escenario existe para agarrar, y contando respuestas se ve idéntico
     * al éxito.
     *
     * Lo que sí los distingue no depende del modelo: la entrega devuelve `null`
     * cuando el filtro rechaza, y un id de caso cuando no.
     */
    prefiltered?: boolean;
    status?: string;
    /**
     * Que el caso haya quedado (o no) en «Para responder»: llegó un mensaje
     * después de que el agente terminó y lo contesta una persona. Con
     * `replies: 0` solo no se distingue de un mensaje que se perdió.
     */
    paraResponder?: boolean;
    /**
     * Qué pide el mensaje que quedó «Para responder» (B3), como lo clasificó el
     * worker. `sin_clasificar` es un mensaje reservado sin clase: el modelo
     * falló o no se llamó.
     */
    tardio?: Tardio;
    /**
     * Claves que el mensaje NO tiene que haber pedido.
     *
     * Sobre `outbound_messages.asked_keys`, que es la lista que el propio
     * producto usa para no repetir un pedido. Afirmar sobre la prosa sería
     * afirmar sobre lo que escribió el modelo, y eso falla al azar.
     *
     * Ojo con lo que esta lista NO distingue: un dato de confianza media
     * aparece acá igual, porque el mensaje lo nombra para que lo confirmen. Para
     * eso está `confirma`.
     */
    noAsked?: string[];
    /**
     * Datos que se propusieron para confirmar en vez de preguntarse a secas.
     *
     * Es el mecanismo de la confianza media, y la diferencia entre «¿cómo te
     * llamás?» y «entendimos Ilan Daniele, ¿es correcto?». Sale de
     * `claim_field_confirmations`, que lo escribe la banda de confianza y no el
     * modelo, así que no depende de cómo redacte ese día.
     */
    confirma?: string[];
    /**
     * Que la derivación abra con una frase de cuidado: alguien contó que hay
     * heridos. Con el mismo predicado que la guarda del redactor.
     */
    cuidado?: boolean;
    /**
     * Que no pida nada. `asked_keys` de una derivación viene siempre vacío, así
     * que lo que muerde es `pideAlgo`, más ancho que la guarda del redactor.
     */
    sinPedido?: boolean;
    /**
     * Que la nota de voz de este turno haya quedado escrita en el mensaje.
     * Sólo con una nota de verdad en disco: el reemplazo es mudo.
     */
    transcribe?: boolean;
  };
}

type Tardio = TipoMensajeTardio | "sin_clasificar";

/**
 * Lo hace una persona desde la pantalla, vía `patchCase`, no por WhatsApp: E24
 * y su espejo. Necesita un actor de verdad (owner/admin, Plan Pro).
 */
interface TurnAccion {
  accion: "tomar_el_control" | "devolver_al_agente";
  expect?: { status?: string; paraResponder?: boolean };
}

/**
 * El recordatorio de lo que falta (B4), como si hubieran pasado `horasDespues`
 * horas. Sólo `recordarCaso` sobre el caso del escenario, con horas propias:
 * nunca el barrido global ni `recordatorio_horas` del tenant.
 */
interface TurnRecordatorio {
  accion: "recordatorio";
  horasDespues: number;
  expect?: { replies?: number; status?: string; recordatorio?: "enviado" | "salteado" | null };
}

type Turn = TurnDicho | TurnAccion | TurnRecordatorio;

interface Scenario {
  id: string;
  what: string;
  /** Which door the claim comes in through. Defaults to WhatsApp. */
  channel?: "whatsapp" | "email";
  /**
   * El nombre visible del sobre, como lo manda un cliente de correo.
   *
   * Por omisión el ensayo entrega la dirección pelada, y producción entrega
   * `Nombre <dirección>`: eso lo acerca a lo que pasa de verdad, y es la única
   * forma de ejercitar que el agente no le pida el nombre a alguien que lo trae
   * en el sobre.
   */
  remitente?: string;
  /**
   * A policy to put on file before the conversation starts, and take off
   * afterwards.
   *
   * The tools are only interesting against a book of business, and this tenant
   * has none loaded yet. Seeded and deleted per scenario so a rehearsal never
   * leaves an invented customer sitting in the real Clientes screen.
   */
  policy?: {
    numero: string;
    dni: string;
    nombre: string;
    vencida?: boolean;
    /** Ramo de la póliza sembrada; sin él es un auto, con su vehículo. */
    ramo?: string;
  };
  /**
   * Que no le devuelva como «¿…, correcto?» lo que la persona acaba de
   * escribir, y que pida la hora siempre de la misma forma (goteo, 23/09).
   *
   * Por escenario y no para todos: mira la prosa del modelo, y en un escenario
   * que no fue pensado para esto sólo agregaría ruido.
   */
  sinEco?: boolean;
  turns: Turn[];
  /** Checked once, after the last turn. */
  finally?: {
    status?: string;
    docsReceived?: string[];
    docsDeclined?: string[];
    /** Field keys that must have survived to the end with a value. */
    knows?: string[];
    /** Tipos de indicio que tienen que estar en `cases.fraud_indicators`. */
    indicios?: string[];
    /** Cuántos adjuntos tienen que haber quedado leídos (`resumen` escrito). */
    leidos?: number;
    /**
     * Quién es el responsable preliminar en `cases.responsabilidad` (B18):
     * `asegurado`, `tercero`, `compartida` o `no_determinable`. Sin opinión
     * escrita se informa `sin_leer`.
     */
    responsabilidad?: string;
    /** Ramo con el que quedó clasificado el caso (`cases.claim_type`), B26. */
    ramo?: string;
  };
}

// Lo que contó de la salud, que la frase de cuidado no repite ni pronostica.
// Aparte de la guarda del redactor: acá se mira el texto que salió.
const LO_MEDICO = ["internad", "quemadur", "recuper", "mejoría", "esté bien"];

const SCENARIOS: Scenario[] = [
  {
    id: "choque-completo",
    what: "Un choque que llega entero, en varios mensajes, y termina listo",
    turns: [
      {
        say: "Hola, choqué ayer a las 19 en Bahía Blanca, Av. Alem al 2300, con mi Gol patente AB 123 CD. Soy Martín Sosa, póliza POL-4471-A, DNI 30.145.882. No hubo heridos.",
        expect: { replies: 1, mentions: ["parte", "licencia"], avoids: ["cubierto", "aprobado"] },
      },
      {
        say: "Ahí van las fotos",
        photo: "danos",
        expect: { attachments: 1, recognises: ["fotos_danos"] },
      },
      {
        // The discriminating case: two paper documents outstanding, and it has
        // to pick the right one rather than the only remaining one.
        say: "Y esta es la licencia",
        photo: "licencia",
        expect: { attachments: 2, recognises: ["licencia_conducir"] },
      },
      {
        say: "No completamos ningún parte amistoso, el otro conductor no quiso",
        // El papel negado no vuelve a la lista, ni como duda del extractor.
        expect: { replies: 1, noAsked: ["parte_amistoso"] },
      },
    ],
    finally: {
      // Que el otro no firmara el parte no es motivo para derivar.
      status: "listo_para_core",
      docsDeclined: ["parte_amistoso"],
      knows: ["policy_number", "full_name"],
    },
  },

  {
    id: "alcance-responsabilidad-clara",
    what: "Un choque por alcance con la responsabilidad clara: el agente sigue pidiendo lo de siempre, no le adelanta la culpa y la opinión queda para el equipo",
    turns: [
      {
        say: "Hola, me chocaron de atrás ayer a las 19 en Bahía Blanca, Av. Alem al 2300, yo estaba parado y el otro auto no frenó. Soy Martín Sosa, patente AB 123 CD, póliza POL-4471-A, DNI 30.145.882. No hubo heridos.",
        expect: {
          replies: 1,
          // La opinión es orientativa y del equipo: al asegurado no se le dice quién tuvo la culpa ni se le cita la ley.
          avoids: ["culpa", "24.449", "24449", "art. 48", "artículo 48", "cubierto", "aprobado"],
          // Ni por ser un choque claro se le piden papeles del otro conductor.
          noAsked: ["party_b_plate", "party_b_name", "party_b_insurer"],
        },
      },
    ],
    finally: { responsabilidad: "tercero" },
  },

  {
    id: "incendio-grave",
    what: "Un incendio con heridos: se deriva y no se le pide nada más",
    turns: [
      {
        say: "Se prendió fuego el auto en la ruta 3, mi señora está internada con quemaduras. Soy Laura Giménez, póliza POL-9982-C.",
        expect: {
          replies: 1,
          mentions: ["especialista"],
          // The failure this branch exists for: telling someone whose partner
          // is in hospital that we need their DNI and the time of the fire.
          avoids: ["DNI", "necesitamos que nos mandes", "fotos", ...LO_MEDICO],
          status: "requiere_especialista",
          cuidado: true,
          sinPedido: true,
        },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "escribe-despues-del-cierre",
    what: "Vuelve a escribir después de la derivación: se suma al caso, el agente calla y queda «Para responder»",
    turns: [
      {
        say: "Se incendió la camioneta en la ruta 33, mi hijo está internado con quemaduras. Soy Marta Ruiz, póliza POL-7731-D.",
        expect: { replies: 1, status: "requiere_especialista" },
      },
      {
        say: "¿Me pueden llamar?",
        expect: { replies: 0, status: "requiere_especialista", paraResponder: true },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "escribe-tarde-pregunta-como-va",
    what: "Derivado, pregunta cómo va: el agente calla, queda «Para responder» y el mensaje se clasifica como consulta de estado (B3)",
    turns: [
      {
        say: "Se prendió fuego el auto en la ruta 3, mi esposo está internado con quemaduras. Soy Clara Méndez, póliza POL-5520-B.",
        expect: { replies: 1, status: "requiere_especialista" },
      },
      {
        say: "¿Cómo va mi denuncia?",
        expect: { replies: 0, status: "requiere_especialista", paraResponder: true, tardio: "consulta_estado" },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "tardio-siniestro-nuevo",
    what: "Derivado, cuenta otro choque en otra fecha: no abre otro caso, queda «Para responder» como siniestro nuevo (B3)",
    turns: [
      {
        say: "Se incendió la moto en la ruta 22, mi hermano está internado con quemaduras. Soy Pablo Ortiz, póliza POL-6610-E.",
        expect: { replies: 1, status: "requiere_especialista" },
      },
      {
        say: "Otra cosa: el sábado 12 de septiembre me chocaron de atrás con el Corsa en Punta Alta. Es otro choque, no tiene nada que ver con el incendio.",
        expect: { replies: 0, status: "requiere_especialista", paraResponder: true, tardio: "siniestro_nuevo" },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "mail-tardio-pregunta-como-va",
    channel: "email",
    what: "Por mail, derivado, contesta en el hilo cómo va: el agente calla, queda «Para responder» y se clasifica (B3)",
    turns: [
      {
        say: [
          "Se incendió la camioneta en la ruta 51 y mi padre está internado con quemaduras.",
          "Soy Nora Vidal, póliza POL-3390-G.",
        ].join("\n"),
        expect: { replies: 1, status: "requiere_especialista" },
      },
      {
        say: "Hola, ¿cómo va mi denuncia? No tuve novedades.",
        // Sin «caso #»: sólo el hilo del proveedor lo puede pegar a su caso.
        subject: "Re: Denuncia de siniestro",
        expect: { replies: 0, status: "requiere_especialista", paraResponder: true, tardio: "consulta_estado" },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "no-es-reclamo",
    what: "Alguien que pregunta por una cotización no abre una denuncia",
    turns: [
      {
        say: "Hola, quería saber cuánto sale asegurar un Gol Trend 2018 en Bahía Blanca.",
        expect: { replies: 0 },
      },
    ],
    finally: { status: "no_relevante" },
  },

  {
    id: "goteo",
    what: "Los datos llegan de a uno; no se vuelve a pedir lo ya contestado",
    sinEco: true,
    turns: [
      { say: "Buenas, tuve un accidente con el auto", expect: { replies: 1 } },
      /*
       * Este turno no afirma que haya respuesta, y es a propósito.
       *
       * Exigía `replies: 1` y fallaba una de cada cinco corridas. No es una
       * regresión —cuatro corridas seguidas en verde después de la roja, y el
       * método de este mismo archivo dice que una regresión aparece en las dos—
       * sino que la entrada cae justo sobre el límite entre dos comportamientos
       * que los dos son correctos.
       *
       * «Fue un choque, ayer a la tarde» agrega datos, así que contestar tiene
       * sentido; pero si el pedido pendiente no cambió, callarse también, y es
       * exactamente la regla que este producto quiso tener: no repetirle el
       * pedido a alguien que no movió el caso. El agente devuelve a veces
       * `intent: wait` acá, y `reply-decision.ts` lo respeta.
       *
       * Lo que este escenario existe para probar lo afirma el turno de abajo:
       * que después de dar el nombre no se lo vuelvan a pedir. Y el silencio
       * tiene su propio escenario, `silencio`, con entradas donde la respuesta
       * no es ambigua: a un «ok» no se le contesta nada.
       *
       * Un ensayo que falla por azar deja de mirarse, y entonces tampoco avisa
       * cuando la falla es de verdad.
       */
      { say: "Fue un choque, ayer a la tarde" },
      { say: "Soy Roberto Paz, DNI 25.888.101", expect: { replies: 1, avoids: ["nombre"] } },
      { say: "La póliza es POL-3311-B", expect: { replies: 1 } },
    ],
  },

  {
    id: "silencio",
    what: "Un mensaje que no aporta nada no merece que se repita el pedido",
    turns: [
      {
        say: "Hola, choqué contra un poste en Alem al 500. Soy Ana Ruiz, DNI 33.221.114.",
        // El tipo ya está dicho: pedirlo era el efecto de un bloque del prompt
        // que hacía caer el choque contra un poste en `other`.
        //
        // Y la provincia se pide, no se afirma: «Alem al 500» no dice cuál, y el
        // 30/09 la respuesta decía «Entendemos que fue en CABA» y a la vez la
        // pedía. `avoids` mira eso; no dice «caba» solo porque está en «acabamos».
        expect: {
          replies: 1,
          noAsked: ["claim_type"],
          avoids: ["en CABA", "Capital Federal", "Buenos Aires"],
        },
      },
      // The three-messages-in-ninety-seconds bug: each round was individually
      // correct, and nobody was reading.
      { say: "ok", expect: { replies: 0 } },
      { say: "gracias", expect: { replies: 0 } },
    ],
  },

  {
    id: "busca-la-poliza",
    what: "Da el DNI y no el número de póliza: el agente lo busca en vez de pedirlo",
    policy: { numero: "POL-8812-R", dni: "27.654.321", nombre: "Cecilia Ferrari" },
    turns: [
      {
        // The whole point of giving it lookups. Asking for a policy number
        // that is sitting in our own database under the DNI they just gave is
        // what a form does.
        say: "Hola, choqué esta mañana en Rivadavia y Chiclana. Soy Cecilia Ferrari, DNI 27.654.321. No hubo heridos.",
        // Ni la pide ni la dicta: el número queda en la denuncia, pero lo que
        // salió del padrón no vuelve a la persona en el mensaje. «POL-8812-R» y
        // «8812» los corta la guarda `dato_del_padron`: el número entero y cada
        // corrida de cuatro dígitos suyos.
        expect: { avoids: ["número de póliza", "numero de poliza", "POL-8812-R", "8812"] },
      },
    ],
    finally: { knows: ["policy_number", "full_name"] },
  },

  {
    id: "mail-que-no-coincide-con-el-padron",
    channel: "email",
    what: "Escribe un familiar del titular: el mensaje tiene que decir los dos valores",
    /*
     * El único mensaje del producto cuyo piso ES un dato.
     *
     * Los otros cuatro son una frase que el redactor puede decir mejor; éste
     * dice cuáles son los dos valores que no coinciden, y sin eso la persona
     * no tiene qué contestar y el caso queda esperando una respuesta que no
     * puede dar. Es AC7 y AC9.
     *
     * No estaba ensayado, y por eso se rompió sin que nadie lo viera: el
     * redactor recibía la instrucción «Señalar la diferencia entre los dos
     * valores» sin ningún valor. Las pruebas unitarias lo agarran ahora, pero
     * la mitad del valor de este ensayo es que una persona LEA el mensaje: un
     * texto que nombra los dos datos y suena a interrogatorio pasa igual todas
     * las verificaciones.
     */
    policy: {
      numero: "POL-3390-F",
      dni: "26.880.140",
      nombre: "Roberto Paz",
    },
    turns: [
      {
        say: [
          "Hola, buenas.",
          "",
          "Escribo por el auto de mi viejo, que ayer lo chocaron estacionado en",
          "Belgrano al 1500. La póliza es POL-3390-F.",
          "",
          "Soy Lucía Paz, DNI 41.207.663.",
        ].join("\n"),
        // Que nombre los dos valores no depende de cómo redacte ese día: si el
        // mensaje no los dice, `violation()` lo rechaza y sale la plantilla,
        // que también los dice. El del padrón sale en iniciales —«R*** P***»—
        // y el entero no puede aparecer: con un DNI ajeno, este mensaje le
        // devolvía al remitente el nombre del titular. Lo que SÍ depende del
        // modelo —si suena a acusación o a pregunta— es lo que hay que leer
        // en el transcripto.
        //
        // `replies: 1` es la mitad que más costó. Salían DOS: el pedido de
        // confirmación y, segundos después, «tu reclamo fue asignado a un
        // especialista». Los dos mensajes son razonables y juntos son un
        // problema: uno le pide que conteste, el otro que espere. Sale sólo el
        // pedido; la derivación que viene atrás no le escribe.
        //
        // Y el pedido no pregunta nada. Salía «¿Cuál es el correcto?» entre el
        // nombre de Lucía y el del padre, que son los dos correctos, en un caso
        // que ya tiene un especialista. Dice la diferencia y avisa eso. Tampoco
        // le atribuye el auto: es «el auto de mi viejo».
        expect: {
          replies: 1,
          mentions: ["R*** P***", "Lucía Paz", "especialista"],
          avoids: ["Roberto Paz", "¿", "tu auto"],
        },
      },
    ],
    // Y la derivación ocurre igual: lo que se suprime es el mensaje al
    // asegurado, no el aviso al especialista ni el estado del caso. Sin esto,
    // « un mensaje por vuelta » se podría cumplir no derivando nunca.
    //
    // Ya no depende de que el modelo delibere «escalate»: las corridas en que
    // no lo hacía terminaban en `confirmacion_pendiente`. El worker ve que ni
    // el nombre ni el DNI son los del titular (`esTitularAjeno`) y el
    // orquestador deriva después del pedido de confirmación, sin preguntarle.
    finally: { status: "requiere_especialista" },
  },

  {
    id: "poliza-vencida",
    what: "Una póliza vencida es para una persona, no para seguir pidiendo papeles",
    policy: {
      numero: "POL-5500-V",
      dni: "24.111.222",
      nombre: "Jorge Peralta",
      vencida: true,
    },
    turns: [
      {
        say: "Buenas, tuve un choque ayer en Villa Mitre. Soy Jorge Peralta, DNI 24.111.222, póliza POL-5500-V.",
        expect: {
          replies: 1,
          // Pedirle fotos de los daños a alguien cuya cobertura venció en 2020
          // le hace perder la tarde a él y a nosotros.
          avoids: ["fotos de los daños", "licencia"],
          status: "requiere_especialista",
        },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "foto-que-no-es-nada",
    what: "Una imagen que no es ningún documento pedido no cierra ningún pedido",
    turns: [
      {
        say: "Choqué en Alem y Sarmiento. Soy Nadia Ferro, DNI 31.909.100, póliza POL-2201-K.",
        expect: { replies: 1 },
      },
      {
        // Someone forwards a screenshot by accident. The direction of caution
        // that matters most: a request marked satisfied by the wrong file
        // disappears from the analyst's list and nobody finds out until the
        // claim stalls. Asking twice is a nuisance; this is a hole.
        say: "Perdón, mandé cualquier cosa",
        photo: "irrelevante",
        expect: { attachments: 1, recognisesNothing: true },
      },
    ],
  },

  {
    id: "archivo-pesado",
    what: "Una foto de más de 10 MB no entra, y se le dice en vez de callar o repetir el pedido",
    turns: [
      { say: "Hola, tuve un choque con el auto ayer a la tarde", expect: { replies: 1 } },
      {
        // Antes se quedaba callado con el pedido en espera, o repetía la lista
        // entera. Cualquiera de los dos caminos —el aviso, o el pedido con la
        // frase al pie— dice «10 MB».
        say: "Ahí te mando la foto del choque",
        pesado: true,
        expect: { replies: 1, mentions: ["10 MB"], attachments: 1, recognisesNothing: true },
      },
    ],
  },

  {
    id: "nota-de-voz-y-pdf",
    what: "Una nota de voz y un PDF se leen, y la fecha del PDF que no coincide queda para el analista",
    policy: { numero: "POL-6100-D", dni: "27.300.400", nombre: "Lucía Paz" },
    turns: [
      {
        say: "Hola, soy Lucía Paz, DNI 27.300.400, póliza POL-6100-D. Choqué el 12 de septiembre de 2026 en Bahía Blanca.",
        expect: { replies: 1 },
      },
      {
        // Como lo deja el webhook: un audio sin texto entra con el marcador.
        say: PLACEHOLDER_AUDIO,
        adjunto: { fixture: "nota-de-voz.ogg", tipo: "audio/ogg; codecs=opus", reemplazo: "placeholder.ogg" },
        expect: { attachments: 1, transcribe: true },
      },
      {
        // La constancia dice 15/09/2026: tres días después de lo que contó.
        say: "Te mando la constancia de la denuncia",
        adjunto: { fixture: "sintetico-constancia.pdf", tipo: "application/pdf" },
        // Lo que no coincide no se le dice a la persona.
        expect: { attachments: 2, avoids: ["no coincide", "inconsisten", "fraude"] },
      },
    ],
    finally: { indicios: ["timeline_inconsistency"], leidos: 2 },
  },

  // ── Email ─────────────────────────────────────────────────────────────────
  //
  // Genuinely different code from here down: threading by subject, a prefilter
  // that decides a message is a newsletter before anyone reads it, stripping
  // the quoted copy of our own mail out of a reply, and wrapping the written
  // prose in HTML. All of it has broken at least once.

  {
    id: "mail-completo",
    channel: "email",
    what: "Una denuncia por mail, en varias respuestas, hasta quedar lista",
    turns: [
      {
        say: [
          "Buenas tardes,",
          "",
          "Les escribo porque ayer choqué en Bahía Blanca, en Av. Alem al 2300.",
          "Soy Martín Sosa, DNI 30.145.882, póliza POL-4471-A. No hubo heridos.",
          "",
          "Saludos,",
          "Martín",
        ].join("\n"),
        expect: { replies: 1 },
      },
      {
        // The reply quotes our own message back, which is how a mail client
        // works and how the extractor once ended up reading our template as
        // though the claimant had written it.
        say: [
          "No completamos ningún parte amistoso, el otro conductor no quiso.",
          "",
          "El mié, 20 ago 2026 a las 21:30, ClaimMix <siniestros@example.com> escribió:",
          "> Necesitamos que nos envíes:",
          "> - Parte amistoso de accidente",
          "> - Fotos de los daños",
        ].join("\n"),
        expect: { replies: 1, noAsked: ["parte_amistoso"] },
      },
    ],
    finally: {
      docsDeclined: ["parte_amistoso"],
      knows: ["policy_number", "full_name"],
    },
  },

  {
    id: "consorcio-por-mail",
    channel: "email",
    what: "Un administrador denuncia daños en las partes comunes de un edificio: es un consorcio y no se le pide patente",
    /*
     * El ramo nuevo de punta a punta, por el canal que usa un administrador.
     * Sin fotos: con el marcador no hay nada que reconocer, y el estado final
     * depende de ellas. Lo que se afirma no depende de cómo redacte el modelo:
     * que conteste una vez, que no pida la patente de un auto que no existe y
     * que los datos del mensaje sobrevivan.
     */
    policy: { numero: "POL-8810-C", dni: "20.111.222", nombre: "Roberto Acosta", ramo: "consorcio" },
    turns: [
      {
        say: [
          "Buenas tardes,",
          "",
          "Soy Roberto Acosta, administrador del consorcio de Av. Alem 2300, en Bahía Blanca, provincia de Buenos Aires.",
          "Ayer se rompió una cañería del tanque de agua, se inundó el hall de entrada y el ascensor quedó fuera de servicio.",
          "La póliza del consorcio es POL-8810-C.",
          "",
          "Saludos,",
          "Roberto",
        ].join("\n"),
        expect: { replies: 1, noAsked: ["patente_vehiculo"] },
      },
    ],
    finally: { knows: ["policy_number", "full_name"], ramo: "consorcio" },
  },

  {
    id: "recordatorio-por-mail",
    channel: "email",
    what: "Queda esperando datos y no contesta: a las 48 h y a los 5 días se le repite el pedido, una sola vez cada uno (B4)",
    /*
     * El reloj se adelanta pasándole `ahora` a `recordarCaso` sobre este caso
     * solo, con horas propias: el ensayo nunca llama al barrido global ni
     * prende los recordatorios del tenant.
     */
    turns: [
      {
        say: "Buenas, ayer me chocaron de atrás en Bahía Blanca. ¿Qué tengo que mandarles?",
        expect: { replies: 1, status: "info_faltante" },
      },
      { accion: "recordatorio", horasDespues: 49, expect: { replies: 1, status: "info_faltante", recordatorio: "enviado" } },
      { accion: "recordatorio", horasDespues: 49, expect: { replies: 0, status: "info_faltante", recordatorio: null } },
      { accion: "recordatorio", horasDespues: 121, expect: { replies: 1, status: "info_faltante", recordatorio: "enviado" } },
    ],
    finally: { status: "info_faltante" },
  },

  {
    id: "mail-sin-nombre-en-el-cuerpo",
    channel: "email",
    what: "El nombre viene en el sobre y no en el mensaje: no se lo pedimos",
    /*
     * El caso real 9f7e8c3a, entero.
     *
     * El `From` decía «Ilan Daniele <ilan…>» y el correo que salió pedía
     * «Nombre completo». No se puede reemplazar cambiándole el remitente a
     * `mail-completo` ni a `mail-grave`: los dos dicen el nombre en el CUERPO,
     * así que el saludo saldría igual venga de donde venga y el escenario
     * quedaría verde sin ejercitar nada — la misma trampa que este archivo ya
     * documenta con el asunto del newsletter.
     *
     * El nombre del fixture no puede contener «no-reply» ni «notificaciones»:
     * el prefiltro normaliza el `fromAddr` ENTERO y descartaría el mensaje, lo
     * que se leería como una regresión del agente y sería el nombre inventado.
     */
    remitente: "Ilan Daniele",
    turns: [
      {
        say: [
          "Buenas, ayer a las 19 choqué con mi Gol patente AB 123 CD en Alem al 2300, en Bahía Blanca.",
          "No hubo heridos. La póliza es POL-4471-A.",
        ].join("\n"),
        // Sobre `asked_keys` y no sobre la prosa: lo que escribe el modelo
        // cambia en cada corrida, y un ensayo que falla al azar se deja de
        // mirar.
        /*
         * Las dos mitades del mismo criterio, y las dos determinísticas.
         *
         * `confirma`: el nombre se propone para confirmar en vez de
         * preguntarse de cero. Sobre `asked_keys` NO se puede afirmar: un dato
         * de confianza media aparece igual en esa lista, porque el mensaje lo
         * nombra.
         *
         * `noAsked`: la dirección del sobre tampoco se pide. Es el mismo
         * principio ya escrito para el teléfono en WhatsApp — no le pidas a
         * alguien el dato desde el que te está escribiendo.
         */
        expect: { replies: 1, confirma: ["full_name"], noAsked: ["email"] },
      },
    ],
    finally: { knows: ["policy_number", "full_name"] },
  },

  {
    id: "mail-no-es-reclamo",
    channel: "email",
    what: "Un newsletter no abre una denuncia ni recibe respuesta",
    turns: [
      {
        // The prefilter should turn this away before a single token is spent
        // on it. Nineteen of these piled up in one day of real inbox testing.
        say: [
          "NEWSLETTER SEPTIEMBRE — Novedades del sector asegurador",
          "",
          "Si no querés recibir más estos correos, hacé clic acá para desuscribirte.",
        ].join("\n"),
        // Con el sobre que trae un newsletter de verdad. Sin esto el ensayo le
        // ponía el asunto «Denuncia de siniestro» a este mensaje también, y el
        // filtro lo dejaba pasar por la palabra «siniestro» del propio asunto
        // que el ensayo le había inventado.
        subject: "NEWSLETTER SEPTIEMBRE — Novedades del sector asegurador",
        headers: [
          { name: "List-Unsubscribe", value: "<https://newsletter.example.com/baja>" },
          { name: "Precedence", value: "bulk" },
        ],
        expect: { replies: 0, prefiltered: true },
      },
    ],
  },

  {
    id: "mail-grave",
    channel: "email",
    what: "Por mail, un incendio con heridos también se deriva y no pide nada",
    turns: [
      {
        say: [
          "Se incendió el auto en la ruta 3 y mi señora está internada con quemaduras.",
          "Soy Laura Giménez, póliza POL-9982-C.",
        ].join("\n"),
        expect: {
          replies: 1,
          status: "requiere_especialista",
          avoids: LO_MEDICO,
          cuidado: true,
          sinPedido: true,
        },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "accidente-personal-fractura",
    what: "Una fractura contada sin palabras de gravedad también deriva",
    turns: [
      {
        say: "Me caí de la moto en Av. Colón al 1200 y me fracturé la muñeca, fui a la guardia y me enyesaron. Soy Pablo Díaz, póliza POL-5521-M.",
        expect: {
          replies: 1,
          status: "requiere_especialista",
          avoids: [...LO_MEDICO, "DNI"],
          sinPedido: true,
        },
      },
    ],
    finally: { status: "requiere_especialista" },
  },

  {
    id: "pregunta",
    what: "Una persona que pregunta algo tiene que recibir una respuesta",
    turns: [
      {
        say: "Choqué el sábado en Villa Mitre, soy Diego Sosa, póliza POL-7745-D, DNI 28.400.900. No hubo heridos.",
        expect: { replies: 1 },
      },
      {
        say: "¿Cuánto suele tardar esto? Necesito el auto para trabajar.",
        // Not a promise — we cannot know — but not silence either. Ignoring a
        // direct question and asking for the next document is the single most
        // robotic thing the agent does.
        expect: { replies: 1, avoids: ["días hábiles", "48 horas", "una semana"] },
      },
    ],
  },

  // ── Tomar el control / Devolver al agente (E24) ─────────────────────────────

  {
    id: "tomar-el-control",
    what: "Una persona toma el control a mitad de la charla y el agente se calla.",
    turns: [
      // El arranque de "choque-completo": dejo el caso en info_faltante con una
      // respuesta, sin ser el escenario que ya lo prueba.
      {
        say: "Hola, choqué ayer a las 19 en Bahía Blanca, Av. Alem al 2300, con mi Gol patente AB 123 CD. Soy Martín Sosa, póliza POL-4471-A, DNI 30.145.882. No hubo heridos.",
        expect: { replies: 1 },
      },
      { accion: "tomar_el_control", expect: { status: "requiere_especialista", paraResponder: false } },
      {
        // Tomado el control, el agente calla y el mensaje queda «Para responder».
        say: "es un gol blanco patente AB123CD, póliza 4455",
        expect: { replies: 0, status: "requiere_especialista", paraResponder: true },
      },
    ],
    finally: { status: "requiere_especialista" },
  },
  {
    id: "devolver-al-agente",
    what: "Tomado y devuelto: el agente retoma con el próximo mensaje.",
    turns: [
      {
        say: "Hola, choqué ayer a las 19 en Bahía Blanca, Av. Alem al 2300, con mi Gol patente AB 123 CD. Soy Martín Sosa, póliza POL-4471-A, DNI 30.145.882. No hubo heridos.",
        expect: { replies: 1 },
      },
      { accion: "tomar_el_control", expect: { status: "requiere_especialista", paraResponder: false } },
      { say: "sigo acá", expect: { replies: 0, paraResponder: true } },
      { accion: "devolver_al_agente", expect: { status: "info_faltante", paraResponder: false } },
      {
        // Devuelto, el agente vuelve a contestar: otra póliza, y pregunta cuál sin repetir ninguna.
        say: "es un gol blanco patente AB123CD, póliza 4455",
        expect: {
          replies: 1,
          paraResponder: false,
          status: "confirmacion_pendiente",
          mentions: ["coincid"],
          avoids: ["4455", "4471"],
        },
      },
      // Elige la anterior escribiéndola: la póliza ya no se vuelve a pedir.
      { say: "la correcta es la POL-4471-A", expect: { replies: 1, noAsked: ["policy_number"] } },
    ],
  },
];

// ── Running one ──────────────────────────────────────────────────────────────

interface Failure {
  scenario: string;
  turn: number;
  /** Para leer: qué se esperaba y qué pasó. Lleva adentro lo que contestó el modelo. */
  why: string;
  /** Para comparar: QUÉ se estaba mirando. Se arma con datos del escenario, nunca con la respuesta. */
  comprobacion: string;
}

const failures: Failure[] = [];
/** Fixture names a scenario asked for and did not find, reported at the end. */
const unrehearsed = new Set<string>();
const RUN = Date.now().toString().slice(-8);

/**
 * The bytes to attach.
 *
 * A named fixture if one exists — drop a real photo of a damaged car in as
 * `tests/fixtures/danos.jpg` and the recognition step gets something it can
 * actually recognise. Otherwise a 1×1 placeholder, which exercises storage and
 * is correctly identified as nothing.
 */
/** Is there a real photograph for this fixture name? */
function haveRealPhoto(photo: string | boolean): boolean {
  return typeof photo === "string" && fs.existsSync(fixturePath(`${photo}.jpg`));
}

function fixturePath(archivo: string): string {
  return path.resolve("tests/fixtures", archivo);
}

/** El archivo que se manda de verdad: el pedido si está en disco, si no el reemplazo. */
function archivoDe(adjunto: NonNullable<TurnDicho["adjunto"]>): string {
  return fs.existsSync(fixturePath(adjunto.fixture)) || !adjunto.reemplazo
    ? adjunto.fixture
    : adjunto.reemplazo;
}

/**
 * The bytes to attach.
 *
 * A real photograph when one is on disk, otherwise a 1×1 placeholder. The
 * placeholder still exercises everything up to recognition — download,
 * validation, upload, the row in claim_attachments — and is correctly
 * identified as nothing, because it is nothing.
 *
 * Real photographs are not in the repository and never will be. Deciding that
 * an image shows a crumpled bumper needs an image of a crumpled bumper, and
 * the licence that makes the discrimination test meaningful is somebody's
 * actual licence: name, address, date of birth, signature. That does not go
 * into a git history, where it would live forever and travel with every clone.
 * See docs/TESTING.md for which files to drop in.
 */
function imageFor(photo: string | boolean): Buffer {
  if (haveRealPhoto(photo)) return fs.readFileSync(fixturePath(`${photo as string}.jpg`));
  return fs.readFileSync(fixturePath("placeholder.jpg"));
}

/**
 * Qué documentos del caso están dados por recibidos en este momento.
 *
 * Se mira antes y después de entregar un turno: lo que aparece en la
 * diferencia es lo que cerró el archivo que acaba de llegar, y es lo único
 * que se le puede atribuir a él. Mirar el total absoluto contaría también lo
 * que cerró un turno anterior.
 */
async function closedDocKeys(id: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: missingDocs.doc_key })
    .from(missingDocs)
    .where(and(eq(missingDocs.case_id, id), isNotNull(missingDocs.satisfied_at)));
  return new Set(rows.map((r) => r.key));
}

/**
 * Anota una diferencia, y CÓMO se la va a reconocer en la corrida siguiente.
 *
 * `why` es para leer: dice qué se esperaba y qué pasó. `comprobacion` es para
 * comparar: dice QUÉ se estaba mirando, sin lo que se vio.
 *
 * La distinción no es cosmética. El post-deploy, cuando algo difiere, corre el
 * ensayo de nuevo e intersecta las dos listas: lo que falló las dos veces es
 * una regresión, lo que falló una es el modelo eligiendo distinto. Esa
 * intersección se hacía sobre `why`, y `why` LLEVA ADENTRO lo que el modelo
 * contestó — «estado info_faltante, esperaba listo», «esperaba 1 respuesta(s),
 * hubo 2».
 *
 * O sea que la misma afirmación rota dos veces, con dos valores distintos,
 * daba dos claves distintas y la intersección salía vacía. Verde. Justo el
 * caso que el reintento existe para atrapar: una regresión que además es
 * inestable se escondía mejor que una determinista.
 *
 * Las claves se arman con datos del ESCENARIO —la clave del campo, la frase
 * esperada— nunca con la respuesta.
 */
function note(scenario: string, turn: number, why: string, comprobacion: string) {
  failures.push({ scenario, turn, why, comprobacion });
  console.log(`      ✗ ${why}`);
}

/**
 * Put one policy on file for the length of a rehearsal.
 *
 * Returns what to delete afterwards. The lookups are only worth exercising
 * against a real row — this tenant's book is empty — and an invented customer
 * left behind would show up in the Clientes screen as a person who does not
 * exist.
 */
async function seedPolicy(
  policy: NonNullable<Scenario["policy"]>
): Promise<{ customerId: string }> {
  const [customer] = await db
    .insert(customers)
    .values({
      tenant_id: TENANT_ID!,
      full_name: policy.nombre,
      dni: policy.dni.replace(/\D/g, ""),
    })
    .returning({ id: customers.id });

  // From here on, anything that throws has to take the customer with it. The
  // first version of this did not, a CHECK constraint rejected the vehicle,
  // and two people who do not exist were left sitting in the Clientes screen.
  try {
    await seedPolicyFor(customer.id, policy);
  } catch (err) {
    await db.delete(customers).where(eq(customers.id, customer.id));
    throw err;
  }

  return { customerId: customer.id };
}

async function seedPolicyFor(
  customerId: string,
  policy: NonNullable<Scenario["policy"]>
): Promise<void> {
  const [row] = await db
    .insert(policies)
    .values({
      tenant_id: TENANT_ID!,
      customer_id: customerId,
      policy_number: policy.numero,
      policy_type: policyTypeDeRamo(policy.ramo),
      status: "active",
      end_date: policy.vencida ? "2020-03-01" : "2099-01-01",
    })
    .returning({ id: policies.id });

  // Un consorcio o una ART no tienen vehículo: sembrarle uno le haría preguntar por él.
  if (policy.ramo && policyTypeDeRamo(policy.ramo) !== "auto") return;

  await db.insert(insuredAssets).values({
    tenant_id: TENANT_ID!,
    policy_id: row.id,
    // The CHECK constraint spells these in English.
    asset_type: "vehicle",
    make: "Fiat",
    model: "Uno",
    year: 2015,
    plate: "AB123CD",
  });
}

/**
 * Hand one message to the WhatsApp intake, exactly as the webhook does.
 */
async function deliverWhatsApp(
  scenario: Scenario,
  turn: TurnDicho,
  i: number,
  phone: string
): Promise<string> {
  const result = await createWhatsAppIntakeAndRunAgent({
    tenantId: TENANT_ID!,
    from: phone,
    body: turn.say,
    providerMessageId: `rehearsal.${RUN}.${scenario.id}.${i}`,
    simulated: true,
    media: turn.photo
      ? [
          {
            id: `rehearsal-${RUN}-${i}`,
            mimeType: "image/jpeg",
            filename: `${typeof turn.photo === "string" ? turn.photo : "foto"}-${i}.jpg`,
            data: imageFor(turn.photo),
          },
        ]
      : turn.pesado
        ? [
            {
              id: `rehearsal-${RUN}-${i}`,
              mimeType: "image/jpeg",
              filename: `pesada-${i}.jpg`,
              data: Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1),
            },
          ]
      : turn.adjunto
        ? [
            {
              id: `rehearsal-${RUN}-${i}`,
              mimeType: turn.adjunto.tipo,
              filename: archivoDe(turn.adjunto),
              data: fs.readFileSync(fixturePath(archivoDe(turn.adjunto))),
            },
          ]
        : undefined,
  });
  return result.caseId;
}

/**
 * Hand one message to the email intake, exactly as the Gmail poller does.
 *
 * Returns the case, or null when the prefilter turned the message away.
 *
 * A reply joins its case by one of two routes. The case number in the subject:
 * our outbound subject puts it there and the claimant's mail client quotes it
 * back. Or the provider thread: same `threadId`, and an In-Reply-To pointing
 * to the claimant's own previous mail, which is what a mail client puts there.
 * Only the turns with a subject of their own (no «caso #») carry the In-Reply-To;
 * the rest keep entering by subject, so both routes stay rehearsed.
 * The route through our own Message-ID cannot be rehearsed — a simulated send
 * has none, because no message was sent.
 */
async function deliverEmail(
  scenario: Scenario,
  turn: TurnDicho,
  i: number,
  address: string,
  caseId: string | null
): Promise<string | null> {
  const subject =
    turn.subject ??
    (caseId ? `Re: Denuncia de siniestro — caso #${caseId}` : "Denuncia de siniestro");

  // La dirección queda ADENTRO de los ángulos: `isReservedTestAddress` la
  // resuelve con `bareAddress`, el barrido de huérfanos va por
  // `cases.email_thread_id` y la limpieza final por id de caso, así que poner
  // nombre visible no rompe ninguna de las dos.
  const fromAddr = scenario.remitente ? `${scenario.remitente} <${address}>` : address;

  const result = await ingestInboundEmail({
    tenantId: TENANT_ID!,
    channel: "email_sim",
    fromAddr,
    toAddr: "siniestros@example.com",
    subject,
    bodyText: turn.say,
    messageId: `rehearsal.${RUN}.${scenario.id}.${i}@example.com`,
    threadId: `thread.${RUN}.${scenario.id}`,
    inReplyTo: caseId && turn.subject ? `<rehearsal.${RUN}.${scenario.id}.${i - 1}@example.com>` : undefined,
    headers: turn.headers,
  });

  if (result.outcome === "skipped") return null;

  await runIntakeAgent({
    caseId: result.caseId,
    tenantId: TENANT_ID!,
    userId: null,
    source: "worker",
  });

  return result.caseId;
}

/**
 * El cuerpo de un mensaje, como lo leería una persona.
 *
 * Vivía acá adentro, y este archivo es un script de top-level await: importarlo
 * lo CORRE, así que no había forma de probarlo. Se cambió cuatro veces en un
 * día —el cierre de etiqueta, el borrado de una pasada, el orden del decode— y
 * cada vez se verificó a mano, en un archivo temporal que ya no existe.
 *
 * Ahora vive en `src/core/email/texto-legible.ts` con su test. Lo que hace y
 * por qué está explicado allá, al lado del código.
 */

/**
 * Si el worker dejó el caso pendiente por un timeout del modelo.
 *
 * En producción lo levanta `retomarExtraccionesPendientes` dos minutos después,
 * con el mismo `runIntakeAgent` que usa acá el ensayo. El ensayo no tiene dos
 * minutos: retoma el caso una vez, en el acto, y sólo cuando el turno esperaba
 * respuesta y no hubo ninguna. Un silencio que el escenario pide no se toca.
 */
async function extraccionPendiente(caseId: string): Promise<boolean> {
  const [row] = await db
    .select({ pending: cases.extraction_pending })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.tenant_id, TENANT_ID!)))
    .limit(1);
  return row?.pending === true;
}

/**
 * Tras un timeout el worker deja el archivo esperando una hora (`plazoAgotado`),
 * y la retoma de producción, dos minutos después, lo saltea igual. La del ensayo
 * tiene que leerlo: con la espera puesta, un timeout sobre la nota de voz o el
 * PDF los dejaba afuera de la retoma y el escenario cerraba con «1 adjunto(s)
 * leído(s), esperaba 2» por una caída de Vertex. Si el modelo vuelve a fallar,
 * la retoma vuelve a marcarlos y el rojo sigue siendo rojo.
 */
async function levantarPlazos(caseId: string): Promise<void> {
  await db
    .update(claimAttachments)
    .set({ metadatos: sql`${claimAttachments.metadatos} - 'plazoAgotado'` })
    .where(and(eq(claimAttachments.case_id, caseId), eq(claimAttachments.tenant_id, TENANT_ID!)));
}

/** Lo que salió, y qué claves pidió. La misma consulta, una columna más. */
async function repliesSince(
  caseId: string,
  seen: number
): Promise<Array<{ body: string; askedKeys: string[] }>> {
  const rows = await db
    .select({
      body: outboundMessages.rendered_body,
      asked_keys: outboundMessages.asked_keys,
    })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.case_id, caseId), eq(outboundMessages.tenant_id, TENANT_ID!)))
    .orderBy(asc(outboundMessages.created_at));
  return rows.slice(seen).map((r) => ({
    body: r.body,
    askedKeys: Array.isArray(r.asked_keys) ? (r.asked_keys as unknown[]).map(String) : [],
  }));
}

/** Un actor de verdad para los turnos de acción — owner, si no admin, con Plan Pro (E24). */
async function actorParaAcciones(): Promise<PatchActor | null> {
  const [row] = await db
    .select({ id: users.id, tenant_id: users.tenant_id, role: users.role, plan: tenants.plan })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenant_id))
    .where(and(eq(users.tenant_id, TENANT_ID!), inArray(users.role, ["owner", "admin"])))
    .orderBy(sql`case ${users.role} when 'owner' then 0 else 1 end`)
    .limit(1);
  return row ?? null;
}

/** Estado, «Para responder» y el mensaje tardío después de un turno o de un turno de acción: el mismo chequeo. */
async function checkStatusYParaResponder(
  scenarioId: string,
  turn: number,
  caseId: string,
  want: { status?: string; paraResponder?: boolean; tardio?: Tardio } | undefined
): Promise<void> {
  if (!want || (!want.status && want.paraResponder === undefined && !want.tardio)) return;
  const row = await db
    .select({
      status: cases.status,
      paraResponderDesde: cases.para_responder_desde,
      tardioDe: cases.mensaje_tardio_de,
      tardioTipo: cases.mensaje_tardio_tipo,
    })
    .from(cases)
    .where(eq(cases.id, caseId));
  if (want.status && row[0]?.status !== want.status) {
    note(scenarioId, turn, `estado ${row[0]?.status}, esperaba ${want.status}`, "estado");
  }
  if (
    want.paraResponder !== undefined &&
    (row[0]?.paraResponderDesde != null) !== want.paraResponder
  ) {
    note(
      scenarioId,
      turn,
      want.paraResponder ? "no quedó «Para responder»" : "quedó «Para responder» y no debía",
      "para-responder"
    );
  }
  if (want.tardio) {
    const tardio = row[0]?.tardioDe == null ? null : (row[0].tardioTipo ?? "sin_clasificar");
    if (tardio !== want.tardio) {
      note(scenarioId, turn, `mensaje tardío ${tardio ?? "sin reservar"}, esperaba ${want.tardio}`, "tardio");
    }
  }
}

async function runScenario(scenario: Scenario, actor: PatchActor | null): Promise<string | null> {
  console.log(`\n▸ ${scenario.id} — ${scenario.what}`);

  // A fresh identity per run, so nothing joins a conversation from an earlier
  // one. The address is @example.com on purpose: that is exactly what the
  // dispatcher checks before deciding never to actually send.
  const index = SCENARIOS.indexOf(scenario);

  // Inventado pero posible: 5490000 + 6 del reloj + el índice son 14 dígitos, y
  // E.164 termina en 15. Antes eran 17 y eso lo hacía un número que no puede
  // existir — el intake lo trata como tal y descarta el teléfono, así que el
  // ensayo recorría un camino que producción no recorre: el agente pedía un
  // correo que a nadie se le pide. Un asegurado inventado tiene que ser
  // inventado en quién es, no en qué forma tiene.
  const phone = `5490000${RUN.slice(-6)}${index}`;
  const address = `ensayo.${RUN}.${index}@example.com`;
  const byEmail = scenario.channel === "email";
  let caseId: string | null = null;
  let seen = 0;
  // Un estado final que depende de reconocer fotos no se puede exigir con el
  // marcador de 1×1: el CI no tiene los fixtures y el caso queda esperando lo
  // que nunca va a reconocer.
  let fotosSinEnsayar = false;
  // Lo último que leyó la persona: en un caso terminado tiene que decirle que
  // por acá ya no sigue nadie.
  let ultimo: string | null = null;
  // Un «No» suelto a «¿Hubo personas lastimadas?» también es hablar de heridos.
  let pedidoAnterior: string[] = [];
  let contestoHeridos = false;
  const formasDeLaHora = new Set<string>();
  // Tomado por una persona: mientras dure, un final en `requiere_especialista`
  // no lleva mensaje de traspaso del agente, porque el agente no escribió.
  let tomado = false;

  const seeded = scenario.policy ? await seedPolicy(scenario.policy) : null;
  try {

    for (const [i, turn] of scenario.turns.entries()) {
      if ("horasDespues" in turn) {
        console.log(`\n   [${i + 1}] ⏰ recordatorio a +${turn.horasDespues} h`);
        if (!caseId) {
          note(scenario.id, i + 1, "recordatorio sin caso previo: ningún turno anterior lo creó", "recordatorio");
          continue;
        }
        const caso: string = caseId;
        const updatedAt = async () =>
          (await db.select({ u: cases.updated_at }).from(cases).where(eq(cases.id, caso)))[0]?.u;
        const antes = await updatedAt();
        let resultado: Awaited<ReturnType<typeof recordarCaso>>;
        try {
          resultado = await recordarCaso(caso, {
            tenantId: TENANT_ID!,
            ahora: new Date(Date.now() + turn.horasDespues * 3_600_000),
            horas: [48, 120],
          });
        } catch (err) {
          // 42703/42P01: falta aplicar la 0039 en esta base, no es un defecto.
          const code = errorCode((err as { cause?: unknown }).cause ?? err);
          note(scenario.id, i + 1, `recordarCaso falló (${code})`, "recordatorio");
          continue;
        }
        const said = await repliesSince(caso, seen);
        seen += said.length;
        if (said.length > 0) ultimo = readable(said[said.length - 1].body);
        if (said.length === 0) console.log("       🤖 (silencio)");
        for (const reply of said) {
          console.log(`       🤖 ${readable(reply.body).replace(/\n/g, "\n          ")}`);
        }

        const want = turn.expect;
        if (want?.replies !== undefined && said.length !== want.replies) {
          note(scenario.id, i + 1, `esperaba ${want.replies} respuesta(s), hubo ${said.length}`, "cantidad-de-respuestas");
        }
        if (want?.recordatorio !== undefined && resultado !== want.recordatorio) {
          note(scenario.id, i + 1, `recordatorio ${resultado}, esperaba ${want.recordatorio}`, "recordatorio");
        }
        // Repite el pedido: las mismas claves que el último.
        const mismas = (claves: string[]) =>
          claves.length === pedidoAnterior.length && claves.every((k) => pedidoAnterior.includes(k));
        if (said.some((r) => !mismas(r.askedKeys))) {
          note(scenario.id, i + 1, "el recordatorio no repite las claves del último pedido", "recordatorio-claves");
        }
        if ((await updatedAt()) !== antes) {
          note(scenario.id, i + 1, "el recordatorio tocó updated_at del caso", "recordatorio-updated-at");
        }
        await checkStatusYParaResponder(scenario.id, i + 1, caso, want);
        continue;
      }
      if ("accion" in turn) {
        console.log(`\n   [${i + 1}] 🧑‍💼 ${turn.accion}`);
        if (!caseId) {
          note(scenario.id, i + 1, "acción sin caso previo: ningún turno anterior lo creó", "accion");
          continue;
        }
        if (!actor) {
          note(scenario.id, i + 1, "sin actor Pro para ejecutar la acción", "accion");
          continue;
        }
        const { patchCase } = await import("@/server/cases/patch");
        const body =
          turn.accion === "tomar_el_control"
            ? { status: "requiere_especialista" as const, reason: "tomar_el_control" }
            : { status: "info_faltante" as const, reason: "devolver_al_agente" };
        try {
          await patchCase(caseId, body, actor, null, "rehearsal");
        } catch (err) {
          if (err instanceof AppError) {
            note(scenario.id, i + 1, `${err.code}: ${err.message}`, "accion");
            continue;
          }
          throw err;
        }
        await checkStatusYParaResponder(scenario.id, i + 1, caseId, turn.expect);
        tomado = turn.accion === "tomar_el_control";
        continue;
      }

      console.log(`\n   [${i + 1}] 👤 ${turn.say}${turn.photo || turn.pesado ? "  📎" : ""}`);

      // Qué estaba cerrado antes de este turno. En el primero no hay caso
      // todavía, y por lo tanto no hay nada cerrado.
      const cerradosAntes = caseId ? await closedDocKeys(caseId) : new Set<string>();

      const delivered = byEmail
        ? await deliverEmail(scenario, turn, i, address, caseId)
        : await deliverWhatsApp(scenario, turn, i, phone);

      if (turn.expect?.prefiltered === true && delivered !== null) {
        note(
          scenario.id,
          i + 1,
          "el filtro de entrada NO lo descartó: se abrió una denuncia con esto",
          "prefiltro"
        );
      }

      if (delivered === null) {
        // The prefilter turned it away. That is an outcome, not a failure —
        // one scenario exists precisely to check that it does.
        console.log("       ⊘ (el filtro de entrada lo descartó)");
        if (turn.expect?.replies !== undefined && turn.expect.replies !== 0) {
          note(scenario.id, i + 1, "el filtro de entrada lo descartó y no debía", "prefiltro");
        }
        continue;
      }
      const active: string = delivered;
      if (byEmail && caseId && active !== caseId) {
        note(scenario.id, i + 1, "abrió otro caso en vez de sumarse al de la conversación", "mismo-caso");
      }
      caseId = active;

      // Se retoma aunque el turno no cuente respuestas. El de la foto espera que
      // se reconozca el documento, y el reconocedor corre después de una
      // extracción que terminó: sin retomar, el ensayo leía el timeout como
      // «no reconoció fotos_danos en la foto».
      let said = await repliesSince(active, seen);
      if (said.length === 0 && turn.expect?.replies !== 0 && (await extraccionPendiente(active))) {
        console.log("       ⟳ el modelo no llegó en treinta segundos; se retoma el caso una vez");
        await levantarPlazos(active);
        await runIntakeAgent({ caseId: active, tenantId: TENANT_ID!, userId: null, source: "worker" });
        said = await repliesSince(active, seen);
      }
      seen += said.length;
      if (said.length > 0) ultimo = readable(said[said.length - 1].body);

      if (said.length === 0) console.log("       🤖 (silencio)");
      for (const reply of said) {
        console.log(`       🤖 ${readable(reply.body).replace(/\n/g, "\n          ")}`);
      }

      // Sobre el texto legible, no sobre el HTML crudo: una frase con comilla o
      // con `&` está ahí como entidad y no machearía nunca, así que la
      // afirmación daría verde sin haber mirado nada.
      const all = said.map((r) => readable(r.body)).join("\n").toLowerCase();

      // Un valor de la base dicho tal cual («(null)», «fue 2026-09-22»). Vale
      // para cada vuelta, espere algo o no.
      const crudo = /\b(?:null|undefined|true|false)\b|\b\d{4}-\d{2}-\d{2}\b/.exec(all);
      if (crudo) note(scenario.id, i + 1, `dice el valor crudo "${crudo[0]}"`, "valor-crudo");

      // «¿Hubo personas lastimadas?: no» a quien nunca habló de heridos (23/09).
      const dijo = scenario.turns
        .slice(0, i + 1)
        .filter((t): t is TurnDicho => "say" in t)
        .map((t) => `${t.subject ?? ""}\n${t.say}`)
        .join("\n");
      contestoHeridos ||= respuestaAHeridos(pedidoAnterior, turn.say) !== null;
      if (!contestoHeridos && !hablaDeHeridos(dijo) && proponeSinHeridos(all)) {
        note(
          scenario.id,
          i + 1,
          "propuso «sin heridos» sin que la persona hablara de heridos",
          "propone-sin-heridos"
        );
      }
      if (scenario.sinEco) {
        // Los valores de lo que se le pidió antes de este turno: lo que no se
        // pidió el orquestador lo confirma a propósito. También lo extraído: la
        // póliza que encontró el agente no deja fila de confirmación, y así se
        // escapó «Entendemos que tu póliza es POL-3311-B, ¿es correcto?».
        const pedidos = new Set(pedidoAnterior.map(canonicalFieldKey));
        const [filas, extraidos] = await Promise.all([
          db
            .select({
              campo: claimFieldConfirmations.field_name,
              valor: claimFieldConfirmations.suggested_value,
            })
            .from(claimFieldConfirmations)
            .where(eq(claimFieldConfirmations.case_id, active)),
          db
            .select({ campo: extractedFields.field_key, valor: extractedFields.field_value })
            .from(extractedFields)
            .where(eq(extractedFields.case_id, active)),
        ]);
        const eco = confirmaLoDicho(
          all,
          `${turn.subject ?? ""}\n${turn.say}`,
          [...filas, ...extraidos]
            .filter((f) => pedidos.has(canonicalFieldKey(f.campo)))
            .map((f) => f.valor ?? "")
        );
        if (eco) {
          note(scenario.id, i + 1, `confirmó lo que acaba de decir: «${eco}»`, "confirma-lo-dicho");
        }
        for (const forma of formaDePedirLaHora(all)) formasDeLaHora.add(forma);
      }

      const pidio = said.filter((r) => r.askedKeys.length > 0);
      if (pidio.length > 0) pedidoAnterior = pidio[pidio.length - 1].askedKeys;

      const want = turn.expect;
      if (!want) continue;

      if (want.replies !== undefined && said.length !== want.replies) {
        note(
          scenario.id,
          i + 1,
          `esperaba ${want.replies} respuesta(s), hubo ${said.length}`,
          "cantidad-de-respuestas"
        );
      }

      const pedidas = new Set(said.flatMap((r) => r.askedKeys));

      for (const phrase of want.mentions ?? []) {
        if (!all.includes(phrase.toLowerCase())) {
          note(scenario.id, i + 1, `no menciona "${phrase}"`, `menciona:${phrase}`);
        }
      }
      for (const phrase of want.avoids ?? []) {
        if (all.includes(phrase.toLowerCase())) {
          note(scenario.id, i + 1, `no debería decir "${phrase}"`, `no-menciona:${phrase}`);
        }
      }
      for (const key of want.noAsked ?? []) {
        if (pedidas.has(key)) note(scenario.id, i + 1, `pidió ${key} y no debía`, `pidio:${key}`);
      }
      if (want.cuidado && !diceCuidado(all)) {
        note(scenario.id, i + 1, "no abre con una frase de cuidado", "cuidado");
      }
      if (want.sinPedido && (pedidas.size > 0 || pideAlgo(all))) {
        note(scenario.id, i + 1, "pidió algo en una derivación", "sin-pedido");
      }
      if (want.confirma?.length) {
        const filas = await db
          .select({ campo: claimFieldConfirmations.field_name })
          .from(claimFieldConfirmations)
          .where(eq(claimFieldConfirmations.case_id, active));
        const propuestos = new Set(filas.map((f) => f.campo));
        for (const key of want.confirma) {
          if (!propuestos.has(key)) {
            note(
              scenario.id,
              i + 1,
              `no propuso confirmar ${key}: se lo preguntó de cero`,
              `propone-confirmar:${key}`
            );
          }
        }
      }
      if (want.attachments !== undefined) {
        const rows = await db
          .select({ id: claimAttachments.id })
          .from(claimAttachments)
          .where(eq(claimAttachments.case_id, active));
        if (rows.length !== want.attachments) {
          note(
            scenario.id,
            i + 1,
            `${rows.length} adjunto(s) guardado(s), esperaba ${want.attachments}`,
            "adjuntos"
          );
        }
      }
      if (want.transcribe && turn.adjunto) {
        if (archivoDe(turn.adjunto) !== turn.adjunto.fixture) {
          unrehearsed.add(turn.adjunto.fixture);
        } else {
          const [transcripto] = await db
            .select({ id: claimMessages.id })
            .from(claimMessages)
            .where(
              and(
                eq(claimMessages.case_id, active),
                sql`${claimMessages.raw_payload}->>'transcripcion' = 'true'`
              )
            )
            .limit(1);
          if (!transcripto) note(scenario.id, i + 1, "la nota de voz no quedó escrita", "transcribe");
        }
      }
      await checkStatusYParaResponder(scenario.id, i + 1, active, want);

      /*
       * El reconocimiento de documentos, que estaba declarado y no se miraba.
       *
       * `recognises` y `recognisesNothing` viven en la interfaz `Turn` desde
       * siempre y se usan en tres turnos, pero el bloque de arriba sólo evaluaba
       * `replies`, `mentions`, `avoids`, `attachments` y `status`. O sea: tres
       * expectativas escritas, cero comprobadas, y el ensayo terminando con «sin
       * diferencias con lo esperado».
       *
       * De las dos, la que más importa es `recognisesNothing`, y por eso se
       * comprueba con cualquier archivo: un documento marcado como recibido sin
       * haber llegado desaparece de la lista del analista, y nadie se entera
       * hasta que la denuncia se muere esperando algo que nunca vino.
       */
      if (want.recognisesNothing || want.recognises?.length) {
        const ahora = await closedDocKeys(active);
        // El contacto lo cierra el canal, no el archivo: igual que en el pen test.
        const cerroAhora = [...ahora].filter(
          (k) => !cerradosAntes.has(k) && !(CONTACT_DOC_KEYS as readonly string[]).includes(k)
        );

        if (want.recognisesNothing && cerroAhora.length > 0) {
          note(
            scenario.id,
            i + 1,
            `dio por recibido ${cerroAhora.join(", ")} y no debía cerrar nada`,
            "cerro-de-mas"
          );
        }

        if (want.recognises?.length) {
          if (!haveRealPhoto(turn.photo ?? false)) {
            // Con el marcador de 1×1 el reconocedor no identifica nada, y hace
            // bien: afirmar lo contrario sería afirmar un bug. Se anota como no
            // ensayado para que la ausencia se lea al final, en vez de pasar por
            // un verde.
            unrehearsed.add(String(turn.photo));
            fotosSinEnsayar = true;
          } else if (await extraccionPendiente(active)) {
            // Dos timeouts seguidos: el reconocedor no llegó a correr, así que
            // decir que no reconoció sería culpar a la parte equivocada.
            note(
              scenario.id,
              i + 1,
              "el modelo no contestó a tiempo y el reconocedor no llegó a correr",
              "modelo-sin-respuesta"
            );
          } else {
            for (const key of want.recognises) {
              if (!cerroAhora.includes(key)) {
                note(scenario.id, i + 1, `no reconoció ${key} en la foto`, `reconoce-en-foto:${key}`);
              }
            }
          }
        }
      }
    }

    // «¿Fue a la tarde, correcto?» y en la vuelta siguiente «Más o menos a qué
    // hora fue.»: la misma pregunta cambiada sin que la persona contestara.
    if (formasDeLaHora.size > 1) {
      note(
        scenario.id,
        0,
        `pidió la hora de ${formasDeLaHora.size} formas: ${[...formasDeLaHora].join(", ")}`,
        "hora-en-una-forma"
      );
    }

    if (caseId && scenario.finally) {
      const want = scenario.finally;
      const [row] = await db
        .select({ status: cases.status, indicios: cases.fraud_indicators, ramo: cases.claim_type })
        .from(cases)
        .where(eq(cases.id, caseId));
      if (want.status && !fotosSinEnsayar && row?.status !== want.status) {
        note(
          scenario.id,
          0,
          `estado final ${row?.status}, esperaba ${want.status}`,
          "estado-final"
        );
      }
      const terminado = row?.status === "listo_para_core" || row?.status === "requiere_especialista";
      // Tomado y sin devolver: no hubo traspaso del agente porque no escribió.
      const saltearTraspaso = tomado && row?.status === "requiere_especialista";
      if (terminado && !saltearTraspaso && ultimo !== null && !mencionaElTraspaso(ultimo)) {
        note(
          scenario.id,
          0,
          "el último mensaje no avisa que la carga termina y que escribe una persona",
          "traspaso"
        );
      }

      const docs = await db
        .select({
          key: missingDocs.doc_key,
          satisfied: missingDocs.satisfied_at,
          declined: missingDocs.declined_at,
        })
        .from(missingDocs)
        .where(eq(missingDocs.case_id, caseId));

      for (const key of want.docsReceived ?? []) {
        if (!docs.find((d) => d.key === key && d.satisfied)) {
          note(scenario.id, 0, `${key} debería figurar como recibido`, `recibido:${key}`);
        }
      }
      for (const key of want.docsDeclined ?? []) {
        if (!docs.find((d) => d.key === key && d.declined)) {
          note(scenario.id, 0, `${key} debería figurar como rechazado`, `rechazado:${key}`);
        }
      }

      if (want.knows?.length) {
        const known = await db
          .select({ key: extractedFields.field_key })
          .from(extractedFields)
          .where(eq(extractedFields.case_id, caseId));
        const keys = new Set(known.map((k) => k.key));
        for (const key of want.knows) {
          if (!keys.has(key)) note(scenario.id, 0, `perdió el dato ${key}`, `perdio-dato:${key}`);
        }
      }

      const tipos = new Set(
        (Array.isArray(row?.indicios) ? row.indicios : []).map((x) => (x as { type?: unknown })?.type)
      );
      for (const tipo of want.indicios ?? []) {
        if (!tipos.has(tipo)) note(scenario.id, 0, `no marcó el indicio ${tipo}`, `indicio:${tipo}`);
      }

      if (want.ramo !== undefined && row?.ramo !== want.ramo) {
        note(scenario.id, 0, `ramo ${row?.ramo ?? "sin clasificar"}, esperaba ${want.ramo}`, "ramo");
      }

      if (want.responsabilidad !== undefined) {
        const [opinion] = await db.select({ responsabilidad: cases.responsabilidad }).from(cases).where(eq(cases.id, caseId));
        const responsable = (opinion?.responsabilidad as { responsable?: string } | null)?.responsable ?? "sin_leer";
        if (responsable !== want.responsabilidad) {
          note(scenario.id, 0, `responsabilidad ${responsable}, esperaba ${want.responsabilidad}`, "responsabilidad");
        }
      }

      if (want.leidos !== undefined) {
        const leidos = await db
          .select({ id: claimAttachments.id })
          .from(claimAttachments)
          .where(and(eq(claimAttachments.case_id, caseId), isNotNull(claimAttachments.resumen)));
        if (leidos.length !== want.leidos) {
          note(scenario.id, 0, `${leidos.length} adjunto(s) leído(s), esperaba ${want.leidos}`, "leidos");
        }
      }

      console.log(
        `\n   estado final: ${row?.status} · docs: ${
          docs
            .map((d) => `${d.key}${d.satisfied ? "✓" : d.declined ? "✗" : "·"}`)
            .join(" ") || "ninguno"
        }`
      );
    }

    return caseId;
  } finally {
    // Cascades to the policy and the insured vehicle.
    if (seeded) await db.delete(customers).where(eq(customers.id, seeded.customerId));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const keep = args.includes("--keep");
/**
 * Dónde dejar las diferencias, para poder comparar dos corridas.
 *
 * Del otro lado hay un modelo: la misma conversación puede terminar distinto.
 * Reintentar entera y exigir que la segunda salga limpia no separa variación
 * de regresión — con medio centenar de afirmaciones que dependen del modelo,
 * que TODAS salgan bien a la vez es improbable, así que el reintento terminaba
 * reportando otras diferencias en vez de confirmar las primeras.
 *
 * Lo que sí las separa es la intersección: una regresión aparece en las dos
 * corridas, una variación casi nunca aparece dos veces. Para intersecar hay
 * que poder leerlas, y para eso están estos archivos.
 */
const reporteIdx = args.indexOf("--reporte");
const reporte = reporteIdx !== -1 ? args[reporteIdx + 1] : null;
// El valor de `--reporte` es un argumento suelto y no un nombre de escenario.
const only = args.filter(
  (a, i) => !a.startsWith("--") && !(reporteIdx !== -1 && i === reporteIdx + 1)
);
const chosen = only.length > 0 ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

if (chosen.length === 0) {
  console.error(`No hay escenario con ese nombre. Hay: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

console.log(
  `Ensayando ${chosen.length} conversación(es) sobre el canal simulado.\n` +
    `Nada sale a un teléfono. Se gastan tokens de verdad.\n`
);

/**
 * Clear out rehearsal cases left behind by a run that died.
 *
 * Every run tidies up after itself, and a run that crashes cannot. One did
 * today — Node aborted on the way out — and left cases sitting in the board
 * looking like real claims from people who do not exist. Once this runs after
 * every deploy rather than when someone remembers, orphans stop being an
 * annoyance and become a slow leak into the analyst's queue.
 *
 * Identified by the invented identities the rehearsal uses: phone numbers in
 * the 5490000-prefixed block and `ensayo.*@example.com` addresses. Nothing a
 * real claimant can have, so this cannot reach a real case.
 */
async function sweepOldRehearsalCases(): Promise<void> {
  try {
    const stale = await db
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.tenant_id, TENANT_ID!),
          inArray(cases.channel, ["whatsapp_sim", "email_sim"]),
          or(
            like(cases.email_thread_id, "5490000%"),
            like(cases.email_thread_id, "thread.%")
          ),
          /*
           * Sólo los VIEJOS. Nunca los de un ensayo en vuelo.
           *
           * El barrido borraba por patrón, sin noción de «míos»: dos ensayos que
           * se solapen contra la misma base se destruyen mutuamente. Pasa de
           * verdad — el post-deploy corre este mismo script contra producción, y
           * si alguien ensaya en local mientras hay un deploy en camino, el
           * barrido del de allá se lleva los casos del de acá.
           *
           * Cuando eso pasa, el síntoma no dice nada: cada escritura falla con
           * 23503 (clave foránea) porque la fila del caso ya no está, y el
           * escenario reporta «estado undefined, esperaba requiere_especialista».
           * Se lee como una regresión del agente y es una colisión de andamio.
           * Me costó media hora.
           *
           * Una hora es de sobra: el ensayo entero tarda unos quince minutos, y
           * un huérfano de verdad quedó de una corrida que ya terminó.
           */
          lt(cases.created_at, sql`now() - interval '1 hour'`)
        )
      );

    if (stale.length === 0) return;

    const { deleteAttachment } = await import("@/server/storage/claim-attachments-bucket");
    for (const row of stale) {
      const files = await db
        .select({ path: claimAttachments.storage_path })
        .from(claimAttachments)
        .where(eq(claimAttachments.case_id, row.id));
      for (const file of files) if (file.path) await deleteAttachment(file.path);
      await db.delete(cases).where(eq(cases.id, row.id));
    }

    console.log(`Limpiados ${stale.length} caso(s) de ensayos anteriores que quedaron colgados.\n`);
  } catch (err) {
    // Not worth failing the run over: the rehearsal itself still cleans up.
    console.error("No se pudo limpiar ensayos viejos:", err instanceof Error ? err.name : "error");
  }
}

/**
 * Sweep a seeded policyholder that a cut-short run left behind.
 *
 * `runScenario` deletes its seed in a `finally`. A process that dies between
 * the seed and that `finally` (a usage limit, a closed terminal) leaves the
 * customer and its policy in the book. From then on every rehearsal, the
 * post-deploy one included, stops at `refuseIfPadronCargado`. It happened on
 * 24/09 with POL-8812-R.
 *
 * A seed is identified by the exact name, DNI and policy number of a
 * scenario's `policy` block, and only when it is older than an hour, like the
 * case sweep. A seed lives for one scenario, so an hour-old seed is not in use.
 * A run killed between the two inserts leaves the customer without a policy,
 * so a customer with no policy at all counts too: on 28/09 one blocked every
 * later seed through the unique DNI.
 */
async function sweepOldSeeds(): Promise<void> {
  const semillas = SCENARIOS.flatMap((s) => (s.policy ? [s.policy] : []));
  if (semillas.length === 0) return;
  try {
    const stale = await db
      .select({ id: customers.id })
      .from(customers)
      .leftJoin(policies, eq(policies.customer_id, customers.id))
      .where(
        and(
          eq(customers.tenant_id, TENANT_ID!),
          lt(customers.created_at, sql`now() - interval '1 hour'`),
          or(
            ...semillas.map((p) =>
              and(
                eq(customers.full_name, p.nombre),
                eq(customers.dni, p.dni.replace(/\D/g, "")),
                or(eq(policies.policy_number, p.numero), isNull(policies.id))
              )
            )
          )
        )
      );
    if (stale.length === 0) return;

    // Cascades to the policy and the insured vehicle, as in runScenario.
    await db.delete(customers).where(inArray(customers.id, [...new Set(stale.map((r) => r.id))]));
    console.log(`Limpiados ${stale.length} titular(es) sembrado(s) que quedaron de ensayos cortados.\n`);
  } catch (err) {
    console.error("No se pudo limpiar titulares sembrados:", err instanceof Error ? err.name : "error");
  }
}

/**
 * Refuse to rehearse against the mock extractor.
 *
 * The whole point is to exercise the real agent — the real model, the real
 * decisions. Run against the mock it still prints twelve tidy conversations
 * and a green tick, and every one of them is canned. That is worse than not
 * running: a suite that reports success without testing anything is how a
 * regression ships with a passing build behind it.
 *
 * It happened. A CI run had the Vertex credentials and no GEMINI_API_KEY, the
 * provider resolver decided no model was available and fell through to mock,
 * and the failures it reported were the mock's behaviour rather than the
 * agent's. Two hours went into a bug that did not exist.
 */
async function refuseIfMocked(): Promise<void> {
  if (process.env.MOCK_AI === "true" || process.env.AI_MOCK === "true") {
    console.error(
      "MOCK_AI está prendido. El ensayo existe para probar el agente de verdad;\n" +
        "contra el mock daría todo verde sin haber probado nada. Apagalo."
    );
    process.exit(1);
  }

  const { resolveExtractionEngine } = await import("@/server/ai/provider");
  const engine = await resolveExtractionEngine(TENANT_ID!);

  if (engine === "mock") {
    console.error(
      [
        "El sistema resolvió el motor de extracción como 'mock', así que no hay",
        "nada que ensayar: las respuestas serían inventadas y todo daría verde.",
        "",
        "Suele ser que faltan credenciales del modelo. Con Vertex hacen falta",
        "GEMINI_TRANSPORT=vertex, GOOGLE_CLOUD_PROJECT y las credenciales de la",
        "service account; con AI Studio, GEMINI_API_KEY.",
      ].join("\n")
    );
    process.exit(1);
  }

  console.log(`Motor de extracción: ${engine}.\n`);
}

/**
 * Refuse to rehearse with the tenant's daily token budget already spent.
 *
 * Same reasoning as refuseIfMocked, one step further along: there the agent
 * answers with something canned, here it does not answer at all. The worker
 * checks the budget before it calls the model, logs a warn, and leaves the
 * case where it was. Every scenario then fails at once — no reply, wrong
 * state, fields never extracted — and the report reads like the agent broke.
 *
 * It happened on 22 August 2026: four post-deploy runs in a row went red with
 * 33 behavioural differences, and not one of them was real. The day's own
 * testing — the load run, the agent pen test, the rehearsals themselves — had
 * spent the tenant's cap, so the model was never called. Whoever reads that
 * report goes hunting a regression that does not exist.
 *
 * The budget is shared with production on purpose: the rehearsal runs as the
 * real tenant, against the real configuration. So it can genuinely run out,
 * and when it does the honest answer is "no lo probé", not a list of failures.
 */
async function refuseIfBudgetSpent(): Promise<void> {
  const { checkBudget } = await import("@/server/ai/budget");
  const budget = await checkBudget(TENANT_ID!);

  if (!budget.exceeded) return;

  console.error(
    [
      `No hay presupuesto: ${budget.reason}`,
      "",
      "Sin modelo el agente no contesta, y una conversación en silencio falla",
      "todas las verificaciones a la vez: parece que el agente se rompió, y lo",
      "único que pasó es que se acabó el cupo. Prefiero fallar acá y decirlo.",
      "",
      "El cupo diario se repone a la medianoche del huso donde corre — UTC en",
      "el runner y en Vercel. Si la suite entera no entra en un día, subí",
      "AI_TENANT_DAILY_TOKEN_CAP en los dos lados: la variable del repo en",
      "GitHub (la usa el ensayo) y la de Vercel (la usa producción).",
      "",
      "El ensayo no tiene usuario, así que gasta del cupo de los canales sin",
      "usuario: sin AI_ANONIMO_DAILY_TOKEN_CAP, el 60 % del tope del inquilino.",
      "Si el motivo de arriba es ése, subí esa variable en los mismos dos lados.",
    ].join("\n")
  );
  process.exit(1);
}

/**
 * Refuse to rehearse when the tenant already has a book of policies.
 *
 * `seedPolicy` says it out loud — this tenant's book is empty — and every
 * scenario without a `policy` block is written on that assumption. The
 * assumption is not about one policy number, it is about the whole table:
 * `verificar_poliza` answers "this insurer has not loaded its book yet, do not
 * treat this as a policy that does not exist" while the table is empty, and
 * "there is no policy with that number" as soon as it holds a single row. The
 * second answer is the one that makes the agent escalate the case to a
 * specialist on the very first turn, and from then on every message joins that
 * case and lands in «Para responder» instead of reaching the agent — a human
 * owns it. Nine behavioural differences, not one of them about the agent, and a
 * day to read them.
 *
 * Production has an empty book today and will not on the day it has customers,
 * so this is not a QA quirk to paper over. The rehearsal says what it found and
 * stops.
 */
async function refuseIfPadronCargado(): Promise<void> {
  const filas = await db
    .select({ numero: policies.policy_number })
    .from(policies)
    .where(eq(policies.tenant_id, TENANT_ID!))
    .limit(5);
  if (filas.length === 0) return;

  console.error(
    [
      `El padrón de este inquilino tiene pólizas cargadas (${filas
        .map((f) => f.numero)
        .join(", ")}…).`,
      "",
      "Los escenarios sin bloque `policy` están escritos para un padrón vacío:",
      "ahí `verificar_poliza` contesta que la aseguradora todavía no cargó el",
      "padrón, y el agente pide la documentación. Con una sola fila cargada",
      "contesta que esa póliza no existe, el caso se deriva a un especialista en",
      "el primer turno, y los mensajes siguientes van a «Para responder» sin que",
      "el agente conteste: el informe sale lleno de diferencias que no son del agente.",
      "",
      "Vaciá el padrón de este inquilino antes de ensayar, o dale a cada",
      "escenario su propio bloque `policy` para que el ensayo siembre el titular",
      "que corresponde.",
    ].join("\n")
  );
  process.exit(1);
}

await refuseIfMocked();
await refuseIfBudgetSpent();
await sweepOldSeeds();
await refuseIfPadronCargado();
await sweepOldRehearsalCases();

// Los turnos de acción los ejecuta una persona de verdad (owner/admin, Plan
// Pro): sin uno, el escenario se reporta sin ensayar en vez de fallar rojo.
const requiereActor = (s: Scenario) => s.turns.some((t) => "accion" in t && t.accion !== "recordatorio");
const actor = chosen.some(requiereActor) ? await actorParaAcciones() : null;
const actorValido = actor !== null && esPlanPro(actor.plan);
if (chosen.some(requiereActor)) {
  if (actorValido) {
    console.log(`Actor de los turnos de acción: ${actor!.id} (${actor!.role}).\n`);
  } else {
    for (const s of chosen) {
      if (requiereActor(s)) unrehearsed.add(`actor:${s.id}`);
    }
  }
}
const paraCorrer = chosen.filter((s) => !requiereActor(s) || actorValido);

const created: string[] = [];
for (const scenario of paraCorrer) {
  try {
    const id = await runScenario(scenario, actor);
    if (id) created.push(id);
  } catch (err) {
    note(
      scenario.id,
      0,
      `se cayó: ${err instanceof Error ? err.message : String(err)}`,
      "se-cayo"
    );
  }
}

console.log("\n" + "─".repeat(70));
if (failures.length === 0) {
  console.log(`✓ ${paraCorrer.length} conversación(es), sin diferencias con lo esperado.`);
} else {
  console.log(`✗ ${failures.length} diferencia(s):\n`);
  for (const f of failures) {
    console.log(`  ${f.scenario}${f.turn ? ` turno ${f.turn}` : " (final)"}: ${f.why}`);
  }
}

if (reporte) {
  fs.writeFileSync(reporte, JSON.stringify(failures, null, 2));
  console.log(`
(diferencias escritas en ${reporte})`);
}

if (unrehearsed.size > 0) {
  // Said out loud rather than left implicit. A suite that reports "todo verde"
  // while quietly skipping a whole capability is worse than one that fails.
  const fotos = [...unrehearsed].filter((n) => !n.startsWith("actor:"));
  const sinActor = [...unrehearsed]
    .filter((n) => n.startsWith("actor:"))
    .map((n) => n.slice("actor:".length));
  if (fotos.length > 0) {
    console.log(
      "\n⋯ Reconocimiento de documentos o notas de voz NO ensayado: faltan " +
        fotos.map((n) => `tests/fixtures/${n.includes(".") ? n : `${n}.jpg`}`).join(", ")
    );
  }
  if (sinActor.length > 0) {
    console.log(
      "\n⋯ Sin actor Pro (owner/admin) para los turnos de acción: " + sinActor.join(", ")
    );
  }
}

if (keep) {
  console.log(`\nCasos dejados en la base:\n${created.map((c) => "  " + c).join("\n")}`);
} else if (created.length > 0) {
  // Rehearsal cases would otherwise sit in the analyst's board looking like
  // real claims from people who do not exist.
  //
  // The files go too. Deleting the case cascades through the database and
  // stops at the bucket, so a fortnight of rehearsals had quietly left a pile
  // of orphaned placeholder images in R2 with nothing pointing at them.
  const { deleteAttachment } = await import("@/server/storage/claim-attachments-bucket");

  for (const id of created) {
    const files = await db
      .select({ path: claimAttachments.storage_path })
      .from(claimAttachments)
      .where(eq(claimAttachments.case_id, id));

    for (const file of files) {
      if (file.path) await deleteAttachment(file.path);
    }

    await db.delete(cases).where(eq(cases.id, id));
  }
  console.log(`\n${created.length} caso(s) de ensayo borrados. Usá --keep para conservarlos.`);
}

// exitCode rather than exit(): calling process.exit() while sockets are
// still closing crashes Node on Windows with a libuv assertion, which looks
// exactly like the run failing and is only the process leaving.
process.exitCode = failures.length === 0 ? 0 : 1;
