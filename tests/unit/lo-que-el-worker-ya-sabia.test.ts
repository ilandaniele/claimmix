/**
 * El agente gastaba hasta cuatro llamadas al modelo buscando lo que el worker
 * ya tenía en la mano.
 *
 * Sus tres herramientas —`verificar_poliza`, `polizas_por_dni` y
 * `historial_del_caso`— contestan preguntas que el worker respondió doscientas
 * líneas antes, en la MISMA invocación: `findCustomerMatches` (que incluye el
 * match por DNI), `findPolicyMatches` y `loadInboundConversation`.
 *
 * Cada herramienta que el modelo pide cuesta una pasada entera del bucle, o sea
 * otra llamada a Gemini —seis segundos en la mediana— dentro de un presupuesto
 * de cuarenta. Con `MAX_TOOL_CALLS = 3`, es la diferencia entre una llamada y
 * cuatro.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ORQ = readFileSync("src/server/confirmations/orchestrate.ts", "utf8");
const DEL = readFileSync("src/server/ai/deliberate.ts", "utf8");

import { loQueYaAveriguamos } from "@/server/confirmations/orchestrate";

const match = (matchType: string, conflicts: string[] = []) =>
  ({
  customerId: "c1",
  matchType,
  confidence: 1,
  customerName: "Juan Pérez",
    conflictsWithExtracted: conflicts,
  }) as never;

describe("lo que ya averiguamos", () => {
  it("dice que la póliza existe, sin decir cuál", () => {
    // Va a un prompt. El modelo no necesita el número para saber que existe.
    const texto = loQueYaAveriguamos([match("policy_number")])!;
    expect(texto).toContain("existe en el padrón");
    expect(texto).not.toContain("Juan Pérez");
  });

  it("y cuántas pólizas tiene ese DNI, sin decir el DNI", () => {
    const texto = loQueYaAveriguamos([match("dni"), match("dni")])!;
    expect(texto).toContain("2 póliza(s)");
  });

  it("el padrón vacío también es una respuesta", () => {
    // Es la que más ahorra: sin esto, el modelo pide `polizas_por_dni` para
    // enterarse de que no hay nada, y eso cuesta una pasada entera.
    const texto = loQueYaAveriguamos([])!;
    expect(texto).toContain("no devolvió ningún cliente");
  });

  it("y los conflictos con lo guardado se nombran por clave", () => {
    const texto = loQueYaAveriguamos([match("dni", ["email", "telefono_contacto"])])!;
    expect(texto).toContain("email");
    expect(texto).toContain("telefono_contacto");
  });

  it("una coincidencia que no es por póliza ni por DNI no se cuenta como si lo fuera", () => {
    // El control: decir «la póliza existe» cuando el match fue por teléfono
    // sería peor que no decir nada — el modelo daría por verificado algo que no
    // se verificó.
    const texto = loQueYaAveriguamos([match("phone")])!;
    expect(texto).not.toContain("existe en el padrón");
    expect(texto).toContain("por contacto");
  });
});

describe("el cableado", () => {
  it("el plan lo recibe y el prompt lo muestra", () => {
    expect(ORQ).toContain("yaAveriguado: loQueYaAveriguamos(customerMatches)");
    expect(DEL).toContain("LO QUE YA AVERIGUAMOS");
  });

  it("y las herramientas siguen estando", () => {
    // No se le saca nada al modelo: si igual quiere preguntar, puede. Lo que
    // cambia es que ya no necesita hacerlo para lo que el worker sabía.
    expect(DEL).toContain("MAX_TOOL_CALLS");
  });
});
