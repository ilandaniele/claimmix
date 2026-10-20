import { readFileSync } from "fs";
import { join, resolve } from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { leerBanderas, type Banderas } from "@/app/api/health/banderas";
import { leerModo } from "@/core/retencion";
import { basePorCliente } from "@/data/bases";
import { altaAbierta } from "@/lib/auth/registro-permitido";
import { diasDePrueba, topeDiarioDelPlan } from "@/lib/billing/plans";
import { TOPES_ENTEROS, topeDecimalEscrito } from "@/lib/topes";
import { resolverAiMode } from "@/server/ai/ai-mode";
import { topeMensualDelProyecto } from "@/server/ai/tope-mensual";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { appPropia, wabaPropia } from "@/server/alta/waba-propia-activa";
import { aprendidoEnConversacion } from "@/server/training/aprendido-en-conversacion";

const ROOT = resolve(__dirname, "../..");

const CLAVES: readonly (keyof Banderas)[] = [
  "ALTA_AUTOMATICA",
  "ALTA_NUMERO_AUTOMATICO",
  "BASE_POR_CLIENTE",
  "ALTA_WABA_PROPIA",
  "ALTA_APP_PROPIA",
  "AGENTE_APRENDIDO_EN_CONVERSACION",
  "AGENT_DELIBERATION",
  "AGENT_COMPOSE_REPLIES",
  "MOCK_AI",
  "AI_MOCK",
  "VERTEX_AI_TUNING_ENABLED",
  "GEMINI_TRANSPORT",
  "RETENCION_MODO",
  "PURGA_ADJUNTOS_MODO",
  "ALTA_TOPE_GLOBAL_DIA",
  "ALTA_TOPE_BASES",
  "ALTA_TOPE_MB",
  "ALTA_TOPE_IP_DIA",
  "ALTA_PRUEBA_DIAS",
  "AI_PILOTO_DAILY_TOKEN_CAP",
  "AI_PRUEBA_MONTHLY_USD_POR_INQUILINO",
  "AI_PRUEBAS_MONTHLY_BUDGET_USD",
  "ALTA_NUMEROS_MAXIMOS_WABA",
  "ALTA_TOPE_NUMEROS_DIA",
  "ALTA_TOPE_CODIGOS_INQUILINO_DIA",
  "ALTA_TOPE_CODIGOS_IP_DIA",
  "ALTA_TOPE_CODIGOS_DIA",
  "ALTA_TOPE_VERIFICACIONES_HORA",
  "ALTA_TOPE_CORREOS_DIA",
  "ALTA_TOPE_POR_DESTINATARIO_DIA",
  "ALTA_TOPE_CORREO_POR_IP_DIA",
  "ALTA_TOPE_INVITACIONES_DIA",
  "ALTA_TOPE_WABAS_SEMANA",
  "ALTA_TOPE_PLANTILLAS_PRUEBA_DIA",
  "MONTHLY_BUDGET_USD",
  "AI_TENANT_DAILY_TOKEN_CAP",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "ALTA_REMITENTE_CORREO",
  "ALTA_REMITENTE_REFRESH_TOKEN",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_TOKEN_ENCRYPTION_KEY",
  "ADMIN_EMAILS",
  "SIGNUP_ALLOWED_EMAILS",
  "VERTEX_EXTRACTION_MODEL",
];

const CARGADAS = CLAVES.slice(-10);

const MODOS = new Set(["vertex", "ai-studio", "apagado", "simular", "borrar", "desconocido"]);

const VALORES = ["1", "0", "true", " 1", ""];

afterEach(() => {
  vi.unstubAllEnvs();
});

function banderasCon(vars: Record<string, string>): Banderas {
  for (const [nombre, valor] of Object.entries(vars)) vi.stubEnv(nombre, valor);
  return leerBanderas(process.env);
}

describe("leerBanderas", () => {
  it("siempre las mismas claves", () => {
    expect(Object.keys(leerBanderas({}))).toEqual(CLAVES);
    const cargado = Object.fromEntries(CLAVES.map((clave) => [clave, "1"]));
    expect(Object.keys(leerBanderas(cargado))).toEqual(CLAVES);
  });

  it("un número inválido da null", () => {
    for (const crudo of ["3500", "abc", "-1", "1.5", "", undefined]) {
      expect(leerBanderas({ ALTA_TOPE_MB: crudo }).ALTA_TOPE_MB, String(crudo)).toBeNull();
    }
    expect(leerBanderas({ ALTA_TOPE_MB: "350" }).ALTA_TOPE_MB).toBe(350);
    expect(leerBanderas({ ALTA_TOPE_MB: "0" }).ALTA_TOPE_MB).toBe(0);

    for (const crudo of ["abc", "-1", ""]) {
      expect(leerBanderas({ MONTHLY_BUDGET_USD: crudo }).MONTHLY_BUDGET_USD, crudo).toBeNull();
    }
    expect(leerBanderas({ MONTHLY_BUDGET_USD: "50" }).MONTHLY_BUDGET_USD).toBe(50);
    expect(leerBanderas({ MONTHLY_BUDGET_USD: "0" }).MONTHLY_BUDGET_USD).toBe(0);
    expect(leerBanderas({ MONTHLY_BUDGET_USD: "12.5" }).MONTHLY_BUDGET_USD).toBe(12.5);
  });

  it("un modo fuera de la lista da desconocido", () => {
    expect(leerBanderas({ RETENCION_MODO: "borrarr" }).RETENCION_MODO).toBe("desconocido");
    expect(leerBanderas({ RETENCION_MODO: " Simular " }).RETENCION_MODO).toBe("simular");
    expect(leerBanderas({}).RETENCION_MODO).toBe("apagado");
    expect(leerBanderas({ PURGA_ADJUNTOS_MODO: "si" }).PURGA_ADJUNTOS_MODO).toBe("desconocido");

    expect(leerBanderas({ GEMINI_TRANSPORT: "vertexx" }).GEMINI_TRANSPORT).toBe("desconocido");
    expect(leerBanderas({ GEMINI_TRANSPORT: " VERTEX " }).GEMINI_TRANSPORT).toBe("vertex");
    expect(leerBanderas({}).GEMINI_TRANSPORT).toBe("ai-studio");
    expect(leerBanderas({ GEMINI_TRANSPORT: "ai-studio" }).GEMINI_TRANSPORT).toBe("ai-studio");
  });

  it("un secreto nunca sale como texto", () => {
    const env = Object.fromEntries(CLAVES.map((clave) => [clave, `fake-${clave.toLowerCase()}-valor`]));
    const banderas = leerBanderas(env);

    expect(JSON.stringify(banderas)).not.toContain("fake-");
    for (const clave of CARGADAS) expect(banderas[clave], clave).toBe(true);
    for (const [clave, valor] of Object.entries(banderas)) {
      const forma = valor === null || typeof valor === "boolean" || typeof valor === "number" || MODOS.has(valor);
      expect(forma, clave).toBe(true);
    }
  });

  it("no recorre el entorno", () => {
    const leidas = new Set<string>();
    const proxy = new Proxy(
      {},
      {
        get(_destino, propiedad) {
          if (typeof propiedad === "string") leidas.add(propiedad);
          return undefined;
        },
        ownKeys() {
          throw new Error("ownKeys");
        },
        has() {
          throw new Error("has");
        },
        getOwnPropertyDescriptor() {
          throw new Error("getOwnPropertyDescriptor");
        },
      }
    );

    expect(() => leerBanderas(proxy)).not.toThrow();
    expect([...leidas].sort()).toEqual([...CLAVES].sort());
  });

  it("los booleanos comparan igual que el código", () => {
    for (const crudo of ["true", "0", ""]) {
      expect(leerBanderas({ ALTA_AUTOMATICA: crudo }).ALTA_AUTOMATICA, crudo).toBe(false);
    }
    expect(leerBanderas({ ALTA_AUTOMATICA: "1" }).ALTA_AUTOMATICA).toBe(true);

    expect(leerBanderas({ MOCK_AI: "true" }).MOCK_AI).toBe(true);
    expect(leerBanderas({ MOCK_AI: "1" }).MOCK_AI).toBe(false);

    expect(leerBanderas({ AGENT_DELIBERATION: "off" }).AGENT_DELIBERATION).toBe(false);
    expect(leerBanderas({}).AGENT_DELIBERATION).toBe(true);
    expect(leerBanderas({ AGENT_DELIBERATION: "OFF" }).AGENT_DELIBERATION).toBe(true);
  });
});

describe("leerBanderas contra los intérpretes del código", () => {
  it("las banderas de una línea", () => {
    for (const v of VALORES) {
      const b = banderasCon({
        ALTA_NUMERO_AUTOMATICO: v,
        BASE_POR_CLIENTE: v,
        AGENTE_APRENDIDO_EN_CONVERSACION: v,
      });
      expect(b.ALTA_NUMERO_AUTOMATICO, JSON.stringify(v)).toBe(numeroAutomatico());
      expect(b.BASE_POR_CLIENTE, JSON.stringify(v)).toBe(basePorCliente());
      expect(b.AGENTE_APRENDIDO_EN_CONVERSACION, JSON.stringify(v)).toBe(aprendidoEnConversacion());
    }
  });

  it("ALTA_AUTOMATICA", () => {
    for (const v of VALORES) {
      const b = banderasCon({ ALTA_AUTOMATICA: v, SIGNUP_ALLOWED_EMAILS: "", ADMIN_EMAILS: "" });
      expect(b.ALTA_AUTOMATICA, JSON.stringify(v)).toBe(altaAbierta("alguien@example.com"));
    }
  });

  it("ALTA_WABA_PROPIA y ALTA_APP_PROPIA", () => {
    for (const v of VALORES) {
      const b = banderasCon({
        ALTA_WABA_PROPIA: v,
        ALTA_APP_PROPIA: v,
        META_APP_ID: "fake-meta-app-id",
        META_ES_CONFIG_ID: "fake-es-config-id",
        WHATSAPP_APP_SECRET: "fake-app-secret",
        NEXT_PUBLIC_SITE_URL: "https://claimmix.example.com",
        WHATSAPP_APP_SECRETS_KEY: "test-app-secrets-key",
      });
      expect(b.ALTA_WABA_PROPIA, JSON.stringify(v)).toBe(wabaPropia());
      expect(b.ALTA_APP_PROPIA, JSON.stringify(v)).toBe(appPropia());
    }
  });

  it("MOCK_AI y AI_MOCK", () => {
    for (const mockAi of ["true", "1", "TRUE", ""]) {
      for (const aiMock of ["true", "1", "TRUE", ""]) {
        const b = banderasCon({ MOCK_AI: mockAi, AI_MOCK: aiMock });
        const real = resolverAiMode({ mockAi, aiMock, geminiConfigurado: true }) === "mock";
        expect(b.MOCK_AI || b.AI_MOCK, `${mockAi} ${aiMock}`).toBe(real);
      }
    }
  });

  it("MONTHLY_BUDGET_USD", () => {
    for (const v of ["50", "0", "12.5", "abc", "-1", "", " 7 "]) {
      const b = banderasCon({ MONTHLY_BUDGET_USD: v });
      expect(topeMensualDelProyecto(), JSON.stringify(v)).toBe(b.MONTHLY_BUDGET_USD ?? 200);
    }
  });

  it("ALTA_PRUEBA_DIAS y AI_PILOTO_DAILY_TOKEN_CAP", () => {
    for (const v of ["10", "0", "91", "abc", ""]) {
      const b = banderasCon({ ALTA_PRUEBA_DIAS: v, AI_PILOTO_DAILY_TOKEN_CAP: v });
      expect(diasDePrueba(), JSON.stringify(v)).toBe(b.ALTA_PRUEBA_DIAS ?? 30);
      expect(topeDiarioDelPlan("piloto"), JSON.stringify(v)).toBe(b.AI_PILOTO_DAILY_TOKEN_CAP ?? 500_000);
    }
  });

  it("los modos de borrado", () => {
    for (const v of ["simular", "BORRAR", " borrar ", "apagado", "si", "borrarr", ""]) {
      const modo = leerBanderas({ RETENCION_MODO: v }).RETENCION_MODO;
      if (modo === "desconocido") expect(leerModo(v), JSON.stringify(v)).toBe("apagado");
      else expect(modo, JSON.stringify(v)).toBe(leerModo(v));
    }
  });
});

describe("leerBanderas contra los lectores que no se importan", () => {
  const LECTORES: [string, string][] = [
    ["src/server/ai/deliberate.ts", 'process.env.AGENT_DELIBERATION !== "off"'],
    ["src/server/ai/compose-reply.ts", 'process.env.AGENT_COMPOSE_REPLIES === "off"'],
    ["src/server/training/vertex-ai-fine-tuning.ts", 'process.env.VERTEX_AI_TUNING_ENABLED === "true"'],
    ["src/server/ai/provider.ts", 'process.env.GEMINI_TRANSPORT?.trim().toLowerCase() !== "vertex"'],
    ["src/server/ai/provider.ts", 'process.env.MOCK_AI === "true" || process.env.AI_MOCK === "true"'],
    ["src/server/storage/purgar-adjuntos.ts", "leerModo(process.env.PURGA_ADJUNTOS_MODO)"],
    ["src/core/retencion.ts", "leerModo(env.RETENCION_MODO)"],
  ];

  it.each(LECTORES)("%s sigue leyendo como banderas.ts: %s", (archivo, texto) => {
    expect(readFileSync(join(ROOT, archivo), "utf8"), `banderas.ts quedó viejo respecto de ${archivo}`).toContain(texto);
  });
});

describe("los rangos de los topes", () => {
  it("cada tope entero está en las claves", () => {
    for (const { nombre } of TOPES_ENTEROS) expect(CLAVES, nombre).toContain(nombre);
  });

  it.each(TOPES_ENTEROS)("$nombre acepta el piso y el techo y rechaza lo de afuera", ({ nombre, min, max }) => {
    expect(leerBanderas({ [nombre]: String(min) })[nombre]).toBe(min);
    expect(leerBanderas({ [nombre]: String(max) })[nombre]).toBe(max);
    expect(leerBanderas({ [nombre]: String(max + 1) })[nombre]).toBeNull();
    expect(leerBanderas({ [nombre]: String(min - 1) })[nombre]).toBeNull();
  });

  it.each(["MONTHLY_BUDGET_USD", "AI_TENANT_DAILY_TOKEN_CAP"] as const)("%s lee igual que topeDecimalEscrito", (nombre) => {
    for (const crudo of ["0", "12.5", "-1", ""]) {
      expect(leerBanderas({ [nombre]: crudo })[nombre], JSON.stringify(crudo)).toBe(topeDecimalEscrito(nombre, { [nombre]: crudo }));
    }
  });
});
