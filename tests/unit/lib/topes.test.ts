import { afterEach, describe, expect, it, vi } from "vitest";
import { TOPE_DIARIO_TOKENS } from "@/lib/billing/plans";
import {
  TOPES_DECIMALES,
  TOPES_ENTEROS,
  readCap,
  topeAnonimo,
  topeDecimal,
  topeDecimalEscrito,
  topeEntero,
  topeEnteroEscrito,
  topeMensualDelProyecto,
} from "@/lib/topes";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("el registro", () => {
  it("los enteros tienen los valores y el orden de hoy", () => {
    expect(TOPES_ENTEROS).toEqual([
      { nombre: "ALTA_TOPE_GLOBAL_DIA", omision: 20, min: 0, max: 500 },
      { nombre: "ALTA_TOPE_BASES", omision: 0, min: 0, max: 500 },
      { nombre: "ALTA_TOPE_MB", omision: 0, min: 0, max: 500 },
      { nombre: "ALTA_TOPE_IP_DIA", omision: 3, min: 1, max: 100 },
      { nombre: "ALTA_PRUEBA_DIAS", omision: 30, min: 1, max: 90 },
      { nombre: "AI_PILOTO_DAILY_TOKEN_CAP", omision: 500_000, min: 1, max: Number.MAX_SAFE_INTEGER },
      { nombre: "AI_PRUEBA_MONTHLY_USD_POR_INQUILINO", omision: 1, min: 0, max: 100_000 },
      { nombre: "AI_PRUEBAS_MONTHLY_BUDGET_USD", omision: 30, min: 0, max: 1_000_000 },
      { nombre: "ALTA_NUMEROS_MAXIMOS_WABA", omision: 2, min: 1, max: 1000 },
      { nombre: "ALTA_TOPE_NUMEROS_DIA", omision: 2, min: 0, max: 50 },
      { nombre: "ALTA_TOPE_CODIGOS_INQUILINO_DIA", omision: 3, min: 0, max: 20 },
      { nombre: "ALTA_TOPE_CODIGOS_IP_DIA", omision: 5, min: 0, max: 50 },
      { nombre: "ALTA_TOPE_CODIGOS_DIA", omision: 10, min: 0, max: 500 },
      { nombre: "ALTA_TOPE_VERIFICACIONES_HORA", omision: 5, min: 0, max: 20 },
      { nombre: "ALTA_TOPE_CORREOS_DIA", omision: 50, min: 1, max: 10_000 },
      { nombre: "ALTA_TOPE_POR_DESTINATARIO_DIA", omision: 3, min: 1, max: 100 },
      { nombre: "ALTA_TOPE_CORREO_POR_IP_DIA", omision: 10, min: 1, max: 1000 },
      { nombre: "ALTA_TOPE_INVITACIONES_DIA", omision: 20, min: 1, max: 1000 },
      { nombre: "ALTA_TOPE_WABAS_SEMANA", omision: 10, min: 0, max: 1000 },
      { nombre: "ALTA_TOPE_PLANTILLAS_PRUEBA_DIA", omision: 3, min: 0, max: 1000 },
    ]);
  });

  it("los decimales tienen los valores y el orden de hoy", () => {
    expect(TOPES_DECIMALES).toEqual([
      { nombre: "MONTHLY_BUDGET_USD", omision: 200 },
      { nombre: "AI_TENANT_DAILY_TOKEN_CAP", omision: 5_000_000 },
      { nombre: "AI_USER_DAILY_TOKEN_CAP", omision: 2_000_000 },
      { nombre: "AI_DEMO_DAILY_TOKEN_CAP", omision: 300_000 },
      { nombre: "DEMO_MONTHLY_BUDGET_USD", omision: 10 },
    ]);
  });

  it("cada omisión cae dentro de su rango", () => {
    for (const { nombre, omision, min, max } of TOPES_ENTEROS) {
      expect(omision, nombre).toBeGreaterThanOrEqual(min);
      expect(omision, nombre).toBeLessThanOrEqual(max);
    }
  });

  it("la omisión del piloto es la del catálogo de planes", () => {
    const piloto = TOPES_ENTEROS.find((t) => t.nombre === "AI_PILOTO_DAILY_TOKEN_CAP");
    expect(piloto?.omision).toBe(TOPE_DIARIO_TOKENS.piloto);
  });
});

describe.each(TOPES_ENTEROS)("$nombre", ({ nombre, omision, min, max }) => {
  it("el piso y el techo se aceptan", () => {
    expect(topeEntero(nombre, { [nombre]: String(min) })).toBe(min);
    expect(topeEntero(nombre, { [nombre]: String(max) })).toBe(max);
    expect(topeEnteroEscrito(nombre, { [nombre]: String(min) })).toBe(min);
    expect(topeEnteroEscrito(nombre, { [nombre]: String(max) })).toBe(max);
  });

  it.each([String(min - 1), String(max + 1), "", "abc", "1.5"])(
    "%j rige la omisión",
    (crudo) => {
      expect(topeEntero(nombre, { [nombre]: crudo })).toBe(omision);
      expect(topeEnteroEscrito(nombre, { [nombre]: crudo })).toBeNull();
    }
  );

  it("sin escribir rige la omisión", () => {
    expect(topeEntero(nombre, {})).toBe(omision);
    expect(topeEnteroEscrito(nombre, {})).toBeNull();
  });

  it("los espacios alrededor de un entero valen", () => {
    expect(topeEntero(nombre, { [nombre]: ` ${min} ` })).toBe(min);
  });
});

describe("topeDecimal", () => {
  it("un cero se respeta y un decimal se lee", () => {
    expect(topeDecimal("MONTHLY_BUDGET_USD", { MONTHLY_BUDGET_USD: "0" })).toBe(0);
    expect(topeDecimal("MONTHLY_BUDGET_USD", { MONTHLY_BUDGET_USD: "12.5" })).toBe(12.5);
    expect(topeDecimalEscrito("MONTHLY_BUDGET_USD", { MONTHLY_BUDGET_USD: "0" })).toBe(0);
    expect(topeDecimalEscrito("MONTHLY_BUDGET_USD", { MONTHLY_BUDGET_USD: "12.5" })).toBe(12.5);
  });

  it.each(["-1", "abc", "", "  "])("%j rige la omisión", (crudo) => {
    const env = { AI_DEMO_DAILY_TOKEN_CAP: crudo };
    expect(topeDecimal("AI_DEMO_DAILY_TOKEN_CAP", env)).toBe(300_000);
    expect(topeDecimalEscrito("AI_DEMO_DAILY_TOKEN_CAP", env)).toBeNull();
  });

  it("sin escribir rige la omisión", () => {
    for (const { nombre, omision } of TOPES_DECIMALES) {
      expect(topeDecimal(nombre, {}), nombre).toBe(omision);
      expect(topeDecimalEscrito(nombre, {}), nombre).toBeNull();
    }
  });

  it("readCap devuelve el respaldo ante vacío, basura o negativo", () => {
    expect(readCap(undefined, 7)).toBe(7);
    expect(readCap("", 7)).toBe(7);
    expect(readCap("Infinity", 7)).toBe(7);
    expect(readCap("-0.5", 7)).toBe(7);
    expect(readCap("0", 7)).toBe(0);
  });

  it("el tope mensual del proyecto es MONTHLY_BUDGET_USD", () => {
    expect(topeMensualDelProyecto({})).toBe(200);
    expect(topeMensualDelProyecto({ MONTHLY_BUDGET_USD: "0" })).toBe(0);
    expect(topeMensualDelProyecto({ MONTHLY_BUDGET_USD: "35" })).toBe(35);
  });
});

describe("topeAnonimo", () => {
  it("sin variable es el 60 % del tope del inquilino", () => {
    expect(topeAnonimo({})).toBe(3_000_000);
    expect(topeAnonimo({ AI_TENANT_DAILY_TOKEN_CAP: "1000" })).toBe(600);
  });

  it("con la variable manda ella, y un cero se respeta", () => {
    expect(topeAnonimo({ AI_ANONIMO_DAILY_TOKEN_CAP: "0" })).toBe(0);
    expect(topeAnonimo({ AI_ANONIMO_DAILY_TOKEN_CAP: "12" })).toBe(12);
  });
});

describe("las lecturas siguen a process.env", () => {
  it("cambiar el entorno entre dos llamadas cambia el resultado", () => {
    vi.stubEnv("ALTA_TOPE_IP_DIA", "7");
    expect(topeEntero("ALTA_TOPE_IP_DIA")).toBe(7);
    vi.stubEnv("ALTA_TOPE_IP_DIA", "8");
    expect(topeEntero("ALTA_TOPE_IP_DIA")).toBe(8);

    vi.stubEnv("MONTHLY_BUDGET_USD", "11");
    expect(topeDecimal("MONTHLY_BUDGET_USD")).toBe(11);
    expect(topeMensualDelProyecto()).toBe(11);
    vi.stubEnv("MONTHLY_BUDGET_USD", "12");
    expect(topeDecimal("MONTHLY_BUDGET_USD")).toBe(12);

    vi.stubEnv("AI_ANONIMO_DAILY_TOKEN_CAP", "5");
    expect(topeAnonimo()).toBe(5);
    vi.stubEnv("AI_ANONIMO_DAILY_TOKEN_CAP", "6");
    expect(topeAnonimo()).toBe(6);
  });
});
