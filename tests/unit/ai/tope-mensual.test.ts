/**
 * El tope mensual del proyecto, leído en un solo lugar.
 *
 * El guardia (`checkBudget`), /configuracion y /api/health lo leen por esta
 * función. Si cada uno parseara a su manera —como hacía la salud, que mostraba
 * 200 donde el guardia frenaba en 0— el número que se ve y el que corta
 * dejarían de ser el mismo.
 */

import { afterEach, describe, expect, it } from "vitest";

import { readCap, topeMensualDelProyecto } from "@/server/ai/tope-mensual";

afterEach(() => {
  delete process.env.MONTHLY_BUDGET_USD;
});

describe("topeMensualDelProyecto", () => {
  it.each([
    ["50", 50],
    ["49.5", 49.5],
    ["0", 0],
  ])("MONTHLY_BUDGET_USD=%j da %d", (valor, esperado) => {
    process.env.MONTHLY_BUDGET_USD = valor;

    expect(topeMensualDelProyecto()).toBe(esperado);
  });

  it("sin la variable, 200", () => {
    delete process.env.MONTHLY_BUDGET_USD;

    expect(topeMensualDelProyecto()).toBe(200);
  });

  it.each(["", "  ", "abc", "-5"])("%j no es un número válido y cae a 200", (valor) => {
    process.env.MONTHLY_BUDGET_USD = valor;

    expect(topeMensualDelProyecto()).toBe(200);
  });
});

describe("readCap", () => {
  it("un cero se respeta: apagar el gasto a propósito es válido", () => {
    expect(readCap("0", 5)).toBe(0);
  });
});
