/**
 * Los prompts del agente, byte a byte.
 *
 * La política del agente está escrita a mano en `prompt.ts`, `deliberate.ts` y
 * `compose-reply.ts`, y se va a mover a otro lugar sin cambiar lo que le llega
 * al modelo. Estos archivos son la prueba de eso: cada uno es el prompt que
 * armó el código antes de moverlo, y un cambio de un solo carácter lo pone en
 * rojo.
 *
 * Nadie corre `vitest -u` sobre `__prompts__` salvo para un cambio de prompt
 * aprobado, y entonces se lee el diff entero: un `-u` después de mover texto
 * borra la prueba.
 *
 * Los datos de ejemplo son de nadie (example.com, nombres genéricos): lo que
 * hay en los .txt lo revisa `check-personal-data`.
 */

vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: vi.fn(),
  errMeta: (e: unknown) => ({
    name: e instanceof Error ? e.name : "UnknownError",
    status: null,
    code: null,
  }),
}));

vi.mock("@/server/ai/agent-tools", () => ({
  describeTools: () => "HERRAMIENTAS DE PRUEBA",
  runTool: vi.fn(),
}));

vi.mock("@/server/ai/budget", () => ({
  reservarSiEsPrueba: vi.fn(async () => ({ exceeded: false })),
  registrarConsumoDelModelo: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn(async () => undefined),
  AuditEvent: { AGENT_DELIBERATION_FAILED: "agent.deliberation_failed" },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEmailClaimPrompt } from "@/server/ai/prompt";
import { deliberate, type DeliberationInput } from "@/server/ai/deliberate";
import { composeReply, type ComposeReplyInput } from "@/server/ai/compose-reply";
import { callGemini } from "@/server/ai/gemini-extractor";
import { runTool } from "@/server/ai/agent-tools";
import { CUIDADO } from "@/core/mensajes/derivacion";
import { POLIZA_CAMBIADA } from "@/core/mensajes/poliza-cambiada";
import { AVISO_DE_TRASPASO } from "@/core/mensajes/traspaso";

const mockCallGemini = callGemini as unknown as ReturnType<typeof vi.fn>;
const mockRunTool = runTool as unknown as ReturnType<typeof vi.fn>;

const respuesta = (text: string) => ({ text, usage: {}, model: "gemini-test" });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("prompts del agente — extracción", () => {
  // Sin la fecha fija, el contexto temporal del prompt cambia todos los días.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T15:00:00Z"));
  });

  const CUERPO =
    "Hola, ayer a la tarde choqué en la esquina de Alem y Sarmiento. El otro auto siguió de largo. " +
    "Mi mail es persona@example.com. Les mando las fotos.";

  it("mail, sin reglas ni entrenamiento del cliente", async () => {
    const prompt = buildEmailClaimPrompt(
      "Choque en esquina",
      CUERPO,
      [],
      [],
      "persona@example.com",
      undefined,
      undefined,
      "email"
    );

    await expect(prompt).toMatchFileSnapshot("./__prompts__/extraccion-mail.txt");
  });

  it("WhatsApp, con entrenamiento y reglas del cliente", async () => {
    const prompt = buildEmailClaimPrompt(
      "Choque en esquina",
      CUERPO,
      [],
      [],
      undefined,
      "Texto de prueba",
      { rules: "- [extraction] Ejemplo: texto de prueba", approvedExamples: "", customFields: "" },
      "whatsapp"
    );

    await expect(prompt).toMatchFileSnapshot("./__prompts__/extraccion-whatsapp-con-reglas.txt");
  });
});

describe("prompts del agente — deliberate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENT_DELIBERATION", "on");
  });

  function situacion(over: Partial<DeliberationInput> = {}): DeliberationInput {
    return {
      caseId: "11111111-1111-1111-1111-111111111111",
      tenantId: "10000000-0000-0000-0000-000000000001",
      outstanding: ["policy_number", "fotos_danos"],
      knownValues: { policy_number: "POL-TEST-1" },
      lastAsked: ["policy_number"],
      latestMessage: "Choqué ayer, ¿cuánto tarda esto?",
      claimTypeLabel: "choque de vehículo",
      isHighSeverity: false,
      isComplete: false,
      yaAveriguado: "- Ya tenemos un caso abierto con este número de teléfono.",
      ...over,
    };
  }

  const PLAN = JSON.stringify({ intent: "ask", ask_for: ["fotos_danos"], reasoning: "falta la foto" });
  const CONSULTA = JSON.stringify({ tool: "verificar_poliza", args: { numero_poliza: "POL-TEST-1" } });
  const OTRA_CONSULTA = JSON.stringify({ tool: "historial_del_caso", args: {} });

  it("primera pasada, con el menú de herramientas", async () => {
    mockCallGemini.mockResolvedValueOnce(respuesta(PLAN));

    expect(await deliberate(situacion())).not.toBeNull();

    await expect(mockCallGemini.mock.calls[0][0] as string).toMatchFileSnapshot(
      "./__prompts__/deliberate-pasada-0.txt"
    );
  });

  it("última pasada, sin menú y con lo que averiguó", async () => {
    // MAX_TOOL_CALLS = 2: dos consultas, y la tercera pasada es la que decide.
    mockRunTool.mockResolvedValue({ sin_datos: true });
    mockCallGemini
      .mockResolvedValueOnce(respuesta(CONSULTA))
      .mockResolvedValueOnce(respuesta(OTRA_CONSULTA))
      .mockResolvedValueOnce(respuesta(PLAN));

    expect(await deliberate(situacion())).not.toBeNull();
    expect(mockCallGemini).toHaveBeenCalledTimes(3);

    await expect(mockCallGemini.mock.calls[2][0] as string).toMatchFileSnapshot(
      "./__prompts__/deliberate-ultima-pasada.txt"
    );
  });
});

describe("prompts del agente — compose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AGENT_COMPOSE_REPLIES", "on");
  });

  function base(over: Partial<ComposeReplyInput>): ComposeReplyInput {
    return {
      intent: "ask",
      channel: "whatsapp",
      tenantId: "10000000-0000-0000-0000-000000000001",
      fallback: "Texto de plantilla, siempre correcto.",
      ...over,
    };
  }

  /** El modelo contesta algo que pasa todas las guardas: un solo intento, y es el que se captura. */
  async function prompt(mensaje: string, input: ComposeReplyInput): Promise<string> {
    mockCallGemini.mockResolvedValueOnce(respuesta(JSON.stringify({ message: mensaje })));

    expect(await composeReply(input)).toBe(mensaje);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);

    return mockCallGemini.mock.calls[0][0] as string;
  }

  it("ask por WhatsApp, con dos campos", async () => {
    const texto = await prompt(
      "Lamento lo del choque. Para seguir necesitamos el número de póliza y el DNI del titular, " +
        "cuando puedas nos los pasás por acá.",
      base({
        intent: "ask",
        channel: "whatsapp",
        fields: ["policy_number", "dni"],
        claimTypeLabel: "choque de vehículo",
        claimantName: "María Prueba",
        lastMessage: "Choqué en Alem y Sarmiento, el auto es un gol blanco. Ver https://example.com/fotos",
      })
    );

    await expect(texto).toMatchFileSnapshot("./__prompts__/compose-ask-whatsapp.txt");
  });

  it("acknowledgement por email", async () => {
    const texto = await prompt(
      "Tomamos nota de lo que nos contaste. Seguimos esperando lo que ya te pedimos.",
      base({
        intent: "acknowledgement",
        channel: "email",
        fields: ["policy_number", "dni"],
        isFollowUp: true,
        lastMessage: "Les cuento que el otro conductor se llama Juan Prueba. Gracias.",
      })
    );

    await expect(texto).toMatchFileSnapshot("./__prompts__/compose-acuse-mail.txt");
  });

  it("escalation por email, con una pregunta y heridos", async () => {
    const texto = await prompt(
      `Hola, María. ${CUIDADO} No podemos decirte cuánto tarda, pero un especialista se va a ` +
        `comunicar con vos. ${AVISO_DE_TRASPASO}`,
      base({
        intent: "escalation",
        channel: "email",
        heridos: true,
        question: "¿Cuánto tarda en llamarme alguien? Lo necesito para trabajar.",
        claimantName: "María Prueba",
        isFollowUp: true,
        lastMessage: "Mi hermano está internado, por favor llámenme.",
      })
    );

    await expect(texto).toMatchFileSnapshot("./__prompts__/compose-derivacion-con-pregunta-mail.txt");
  });

  it("conflict con la póliza cambiada, por WhatsApp", async () => {
    const texto = await prompt(
      `Gracias por avisarnos. ${POLIZA_CAMBIADA}`,
      base({
        intent: "conflict",
        channel: "whatsapp",
        polizaCambiada: true,
        isFollowUp: true,
        lastMessage: "Es un gol blanco, patente AB123CD, póliza 4455",
      })
    );

    await expect(texto).toMatchFileSnapshot("./__prompts__/compose-poliza-cambiada-whatsapp.txt");
  });

  it("recordatorio de un pedido, por WhatsApp", async () => {
    const texto = await prompt(
      "Hola, Marta. Te recordamos que necesitamos el número de póliza para seguir con tu caso.",
      base({
        intent: "ask",
        channel: "whatsapp",
        fields: ["policy_number"],
        claimantName: "Marta Prueba",
        isFollowUp: true,
        repitePedido: true,
      })
    );

    await expect(texto).toMatchFileSnapshot("./__prompts__/compose-recordatorio-whatsapp.txt");
  });
});
