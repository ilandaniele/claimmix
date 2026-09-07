/**
 * El mail que lee un asegurado, escrito por el mismo que escribe los de
 * WhatsApp.
 *
 * `emailMessenger` era `await dispatchOutboundEmail(message)` y nada más: la
 * plantilla determinista salía tal cual, mientras la misma decisión por
 * WhatsApp salía redactada. Una sola cabeza y dos productos con la misma cara.
 *
 * Lo que se afirma acá es todo determinístico: que el redactor se llama, con
 * qué intención, con qué piso, y —sobre todo— que cuando rebota una guarda lo
 * que sale es la plantilla intacta. El tono no está acá; eso se lee en el
 * transcripto de `pnpm rehearse`.
 */

const gmail = vi.hoisted(() => ({
  send: vi.fn(),
  cuenta: vi.fn(),
}));

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: { OUTBOUND_EMAIL_SENT: "sent", OUTBOUND_EMAIL_FAILED: "failed" },
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: gmail.cuenta,
  getGmailAccountByEmail: gmail.cuenta,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: vi.fn().mockImplementation(function GmailSender() {
    return { name: "gmail", send: gmail.send };
  }),
}));

vi.mock("@/server/whatsapp/cloud-api", () => ({ sendWhatsAppText: vi.fn() }));

// El redactor de verdad, espiado. Las guardas, el reintento y el interruptor
// son parte de lo que se prueba; lo único simulado es el modelo.
vi.mock("@/server/ai/compose-reply", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/ai/compose-reply")>();
  return { ...real, composeReply: vi.fn(real.composeReply) };
});

/*
 * Y el modelo, explícitamente.
 *
 * No alcanza con que `callGemini` tire por falta de entorno —que es como pasan
 * hoy los tests del mensajero de WhatsApp—: el día que alguien tenga
 * GEMINI_API_KEY en su shell, esta suite sale a la red de verdad.
 */
vi.mock("@/server/ai/gemini-extractor", () => ({ callGemini: vi.fn() }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { emailMessenger } from "@/server/confirmations/messenger";
import { composeReply } from "@/server/ai/compose-reply";
import { callGemini } from "@/server/ai/gemini-extractor";
import { renderTemplate, type EmailTemplate } from "@/server/email/render";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";
const TO = "asegurado@acme-seguros.com.ar";
/** Reservada por la IANA: el despachador guarda el preview y no envía. */
const TO_RESERVADA = "ensayo.1@example.com";

const compose = composeReply as unknown as ReturnType<typeof vi.fn>;
const modelo = callGemini as unknown as ReturnType<typeof vi.fn>;

/** Todo lo que se escribió en `outbound_messages` en esta corrida. */
let filas: Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENT_COMPOSE_REPLIES;
  filas = [];

  Object.assign(db, {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: () => [] }) }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        if ("rendered_body" in v) filas.push(v);
        const filaNueva = [{ id: "row-1" }];
        return Object.assign(Promise.resolve(filaNueva), {
          returning: () => Promise.resolve(filaNueva),
        });
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  });

  gmail.cuenta.mockResolvedValue({
    email: "siniestros@acme-seguros.com.ar",
    refreshToken: "t",
    enabled: true,
  });
  gmail.send.mockResolvedValue({ providerMessageId: "out-1", rfcMessageId: "<out-1@x>" });
});

/** Que el modelo devuelva este mensaje. */
function escribe(message: string) {
  modelo.mockResolvedValue({
    text: JSON.stringify({ message }),
    usage: { promptTokens: 0, completionTokens: 0 },
  });
}

const PEDIDO = {
  caseId: CASE,
  missingFields: ["policy_number"],
  claimantName: "Ilan",
};

async function mandar(
  template: EmailTemplate,
  data: Record<string, unknown>,
  to = TO
) {
  await emailMessenger.send({ caseId: CASE, tenantId: TENANT, to, template, data });
}

/** El cuerpo del correo tal como quedó en el libro mayor. */
function cuerpoEnviado(): string {
  return String(filas[0]?.rendered_body ?? "");
}

describe("emailMessenger — pasa por el redactor", () => {
  it("lo llama con el canal del correo", async () => {
    escribe("Ilan, para seguir con tu reclamo necesitamos el número de póliza. Contanos y avanzamos.");

    await mandar("missing_information_request", PEDIDO);

    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose.mock.calls[0][0]).toMatchObject({ channel: "email", intent: "ask" });
  });

  it.each([
    ["specialist_escalation", "escalation"],
    ["missing_information_request", "ask"],
    ["data_confirmation_request", "conflict"],
    ["information_received", "acknowledgement"],
    ["confirmation_received", "closing"],
  ] as Array<[EmailTemplate, string]>)(
    "%s se redacta como %s",
    async (template, intent) => {
      escribe("Un mensaje cualquiera, suficientemente largo para pasar el mínimo.");

      await mandar(template, { caseId: CASE, fieldKey: "dni", proposedValue: "****5678" });

      expect(compose.mock.calls[0][0]).toMatchObject({ intent });
    }
  );

  it("el piso que le entrega es la prosa, no el documento entero", async () => {
    /*
     * Pasarle `rendered.text` haría que el modelo reescriba el pie y la línea
     * «Caso de referencia», queme los 1400 caracteres en cromo y coseche
     * rechazos por largo sin motivo real.
     */
    escribe("Ilan, nos falta el número de póliza para poder seguir con tu reclamo.");

    await mandar("missing_information_request", PEDIDO);

    const piso = String(compose.mock.calls[0][0].fallback);
    expect(piso).toContain("Número de póliza");
    expect(piso).not.toContain("Este mensaje fue generado automáticamente");
    expect(piso).not.toContain("Caso de referencia");
    expect(piso).not.toContain("<!DOCTYPE");
  });

  it("la prosa redactada llega al correo, escapada, y el cromo queda", async () => {
    escribe("Ilan, para seguir con tu reclamo necesitamos el número de póliza.\n\n- Número de póliza\n\nRespondé este correo y avanzamos.");

    await mandar("missing_information_request", PEDIDO);

    const html = cuerpoEnviado();
    expect(html).toContain("<p>Ilan, para seguir con tu reclamo");
    expect(html).toContain("<li>Número de póliza</li>");
    // El cromo que las guardas del redactor no protegen.
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(`Caso de referencia: #${CASE}`);
  });
});

describe("emailMessenger — cuando el redactor no puede", () => {
  it("un rechazo devuelve la plantilla intacta, byte a byte", async () => {
    // Dos intentos que se comen el campo que había que pedir.
    escribe("Gracias por escribirnos, seguimos trabajando en tu caso sin más detalle.");

    await mandar("missing_information_request", PEDIDO);

    const piso = renderTemplate("missing_information_request", PEDIDO);
    expect(cuerpoEnviado()).toBe(piso.html);
  });

  it("y el motivo del rechazo nunca sale al correo", async () => {
    escribe("Gracias por escribirnos, seguimos trabajando en tu caso sin más detalle.");

    await mandar("missing_information_request", PEDIDO);

    const html = cuerpoEnviado();
    for (const motivo of ["dropped_field", "forbidden", "too_long", "escalation_asks_for_data"]) {
      expect(html).not.toContain(motivo);
    }
  });

  it("con la redacción apagada sale la plantilla y no se llama al modelo", async () => {
    // Es el único botón de emergencia del canal con más tráfico, y desde este
    // cambio también apaga el mail.
    process.env.AGENT_COMPOSE_REPLIES = "off";
    escribe("Un mensaje perfectamente bueno sobre el número de póliza.");

    await mandar("missing_information_request", PEDIDO);

    expect(modelo).not.toHaveBeenCalled();
    expect(cuerpoEnviado()).toBe(renderTemplate("missing_information_request", PEDIDO).html);
  });

  it("un redactor que explota no impide el envío", async () => {
    // La denuncia ya está extraída y guardada: una falla de mensajería no la
    // puede deshacer.
    compose.mockRejectedValueOnce(new Error("boom"));

    await mandar("missing_information_request", PEDIDO);

    expect(cuerpoEnviado()).toBe(renderTemplate("missing_information_request", PEDIDO).html);
  });
});

describe("emailMessenger — los dos caminos del despachador", () => {
  it("el preview del ensayo y el envío real dicen exactamente lo mismo", async () => {
    /*
     * La invariante de la que depende todo el ensayo, y que hoy no tenía
     * testigo. `dispatch` arma el correo en dos lugares —el preview que graba
     * para una dirección reservada y el envío de verdad— y los dos llaman al
     * mismo `renderTemplate(template, data)`. Por eso la prosa redactada viaja
     * ADENTRO de `data`: si se enchufara por debajo del `return` de la
     * dirección reservada, el ensayo leería plantilla cruda para siempre y
     * todo seguiría en verde.
     */
    escribe("Ilan, para seguir con tu reclamo necesitamos el número de póliza. Respondé este correo.");

    await mandar("missing_information_request", PEDIDO, TO_RESERVADA);
    await mandar("missing_information_request", PEDIDO, TO);

    expect(filas).toHaveLength(2);
    expect(filas[0].status).toBe("skipped_simulated");
    expect(filas[1].status).toBe("queued");
    expect(filas[0].rendered_body).toBe(filas[1].rendered_body);
    expect(String(filas[0].rendered_body)).toContain("Ilan, para seguir");
  });

  it("y a una dirección reservada no se le manda nada", async () => {
    escribe("Ilan, para seguir con tu reclamo necesitamos el número de póliza.");

    await mandar("missing_information_request", PEDIDO, TO_RESERVADA);

    expect(gmail.send).not.toHaveBeenCalled();
  });

  it("la versión en texto no se queda con la plantilla mientras el HTML lleva la prosa", async () => {
    // Si divergieran, la pantalla del caso le mostraría al analista un mensaje
    // que el asegurado nunca recibió: `claim_messages.body_text` sale del
    // mismo render que el `htmlBody` del envío.
    escribe("Ilan, para seguir con tu reclamo necesitamos el número de póliza. Respondé este correo.");

    await mandar("missing_information_request", PEDIDO);

    const enviado = gmail.send.mock.calls[0][0] as { htmlBody: string; textBody: string };
    expect(enviado.htmlBody).toContain("Ilan, para seguir");
    expect(enviado.textBody).toContain("Ilan, para seguir");
    expect(enviado.textBody).not.toContain("<p>");
  });

  it("el asunto no lo toca el redactor", async () => {
    escribe("Ilan, para seguir con tu reclamo necesitamos el número de póliza.");

    await mandar("missing_information_request", PEDIDO);

    const enviado = gmail.send.mock.calls[0][0] as { subject: string };
    expect(enviado.subject).toBe(renderTemplate("missing_information_request", PEDIDO).subject);
  });
});

/**
 * El correo de conflicto es el único cuyo piso ES un dato.
 *
 * Los otros cuatro pisos son una frase que el redactor puede decir mejor. Éste
 * dice «el DNI que nos diste termina en 1222 y el que tenemos termina en 5678,
 * ¿cuál va?», y AC7/AC9 son exactamente eso: si la prosa reemplaza el cuerpo y
 * no nombra los dos valores, a la persona le llega un mail que le avisa que
 * hay una diferencia sin decir en qué dato ni entre qué, no puede contestar, y
 * el caso queda trabado en `confirmacion_pendiente` esperándola.
 *
 * Pasaba: `writeReply` mapeaba `fields` desde `data.missingFields`, y la rama
 * de conflictos manda `data.fields`. El redactor recibía `undefined` y la
 * instrucción «Señalar la diferencia entre los dos valores» sin ningún valor.
 */
describe("emailMessenger — el conflicto lleva sus valores", () => {
  const CONFLICTO = {
    caseId: CASE,
    claimantName: "Ilan",
    fields: [
      { fieldKey: "dni", proposedValue: "30111222", conflictWithValue: "20345678" },
      {
        fieldKey: "full_name",
        proposedValue: "Juan Perez",
        conflictWithValue: "Roberto Paz",
      },
    ],
  };

  it("el redactor recibe los dos valores de cada campo", async () => {
    escribe(
      "Ilan, encontramos dos diferencias. El documento que nos diste termina en ****1222 " +
        "y el que figura en nuestro sistema termina en ****5678. Y el nombre: vos nos " +
        'decís "Juan Perez" y nosotros tenemos "Roberto Paz". ¿Cuáles son los correctos?'
    );

    await mandar("data_confirmation_request", CONFLICTO);

    expect(compose.mock.calls[0][0]).toMatchObject({
      intent: "conflict",
      conflicts: [
        { fieldKey: "dni", proposed: "****1222", stored: "****5678" },
        { fieldKey: "full_name", proposed: "Juan Perez", stored: "Roberto Paz" },
      ],
    });
  });

  it("el DNI le llega enmascarado, no entero", async () => {
    // AC24. La plantilla enmascaraba al renderizar, o sea después; con la prosa
    // en el medio ese enmascarado ya no está en el camino. Un número que el
    // modelo no ve es uno que no puede copiar.
    escribe(
      "Ilan, el documento que nos diste termina en ****1222 y el que tenemos termina " +
        'en ****5678. También difiere el nombre: "Juan Perez" contra "Roberto Paz". ' +
        "¿Cuáles son los correctos?"
    );

    await mandar("data_confirmation_request", CONFLICTO);

    const prompt = String(modelo.mock.calls[0][0].prompt ?? modelo.mock.calls[0][0]);
    expect(prompt).not.toContain("30111222");
    expect(prompt).not.toContain("20345678");
    expect(prompt).toContain("****1222");
    expect(prompt).toContain("****5678");
  });

  it("una prosa que no nombra los valores no sale: sale la plantilla", async () => {
    // Sin esto, cualquier párrafo vago de más de veinte caracteres pasaba a la
    // primera, porque la verificación de campos caídos sólo corría para `ask`.
    escribe(
      "Hola Ilan, notamos una diferencia entre lo que nos indicaste y lo que figura " +
        "en nuestro sistema. Decinos cuál es el correcto y seguimos."
    );

    await mandar("data_confirmation_request", CONFLICTO);

    // Dos intentos: el primero rechazado, el segundo también, y después el piso.
    expect(modelo).toHaveBeenCalledTimes(2);

    // Byte a byte la plantilla, igual que el resto de los rechazos: con los
    // dos bloques «Campo: ...» y el pedido de responder «Confirmo», que es
    // lo único que le da a la persona una forma de contestar.
    const piso = renderTemplate("data_confirmation_request", CONFLICTO);
    expect(cuerpoEnviado()).toBe(piso.html);
    expect(cuerpoEnviado()).toContain("Confirmo");
  });

  it("un conflicto sin el valor guardado no se le pide al redactor", async () => {
    // No es un conflicto sino un dato que falta, y la guarda no tendría contra
    // qué comparar: pedirle que nombre "los dos valores" cuando hay uno solo es
    // mandarlo a fallar.
    escribe("Ilan, necesitamos que nos confirmes tu documento para poder seguir.");

    await mandar("data_confirmation_request", {
      caseId: CASE,
      fields: [{ fieldKey: "dni", proposedValue: "30111222", conflictWithValue: null }],
    });

    expect(compose.mock.calls[0][0]).toMatchObject({ conflicts: [] });
  });
});

/**
 * Lo que la persona escribió entra al prompt para dar tono, y trae su DNI.
 *
 * Se lo pedimos nosotros, así que viene entero. Mientras el cuerpo lo armaba la
 * plantilla eso no salía a ningún lado; desde que la prosa lo reemplaza, lo que
 * el modelo leyó puede terminar en el mail.
 */
describe("emailMessenger — el mensaje de la persona entra sin números enteros", () => {
  it("el DNI del cuerpo del correo no llega al prompt", async () => {
    escribe("Ilan, para seguir con tu reclamo necesitamos el número de póliza.");

    await emailMessenger.send({
      caseId: CASE,
      tenantId: TENANT,
      to: TO,
      template: "missing_information_request",
      data: PEDIDO,
      lastMessage:
        "Tuve un choque con mi renault clio patente ABC-321. Mi dni es 38919917 y " +
        "mi póliza es POL-12345678.",
    });

    const prompt = String(modelo.mock.calls[0][0].prompt ?? modelo.mock.calls[0][0]);
    expect(prompt).not.toContain("38919917");
    expect(prompt).not.toContain("POL-12345678");
    expect(prompt).toContain("****9917");
    // La patente no es un número entero de nadie y sirve para el tono.
    expect(prompt).toContain("ABC-321");
  });
});
