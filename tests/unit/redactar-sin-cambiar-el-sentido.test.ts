/**
 * Tachar un dato es una cosa; borrarle una palabra a una oración es otra.
 *
 * El patrón de póliza era `\bpóliza\s+[\dA-Za-z-]+`: se comía CUALQUIER palabra
 * que viniera detrás de «póliza». En un valor eso es tachar de más, que es la
 * decisión declarada del módulo y está bien. En prosa cambia el sentido:
 *
 *   «sin la póliza no se puede abrir el expediente»
 *   → «sin la [POLIZA] se puede abrir el expediente»
 *
 * El «no» desapareció y la frase quedó diciendo lo contrario. Vive en el
 * `audit_log`, que es donde una aseguradora va a buscar POR QUÉ el agente hizo
 * lo que hizo.
 *
 * Lo destapó aplicar `redactObject` al payload de `agent.deliberated`, que lleva
 * el `reasoning` del modelo. Un test que ya existía se puso rojo con la frase
 * invertida adentro.
 */

import { describe, it, expect } from "vitest";

import { redactString, redactObject } from "@/lib/audit/redact";

describe("el redactor no se come palabras de al lado", () => {
  it("«póliza no» conserva el «no»", () => {
    expect(redactString("sin la póliza no se puede abrir el expediente")).toBe(
      "sin la póliza no se puede abrir el expediente"
    );
  });

  it("y ninguna otra palabra común detrás de «póliza»", () => {
    for (const frase of [
      "la póliza vencida no cubre el siniestro",
      "pedimos la póliza pero todavía no llegó",
      "su póliza figura activa",
    ]) {
      expect(redactString(frase)).toBe(frase);
    }
  });

  it("pero un número de póliza SÍ se tacha, que es para lo que existe", () => {
    // El control. Un patrón que dejara de matchear arreglaría la prosa dejando
    // el documento a la vista, que es el defecto que el módulo vino a cerrar.
    expect(redactString("póliza 0000-9999")).toContain("[POLIZA]");
    expect(redactString("póliza 0000-9999")).not.toContain("0000-9999");
    expect(redactString("la POL-2024-001 está vigente")).toContain("[POLIZA]");
  });

  it("y el DNI también", () => {
    expect(redactString("DNI 25.888.101")).toContain("[DNI]");
    expect(redactString("DNI 25.888.101")).not.toContain("25.888.101");
  });
});

describe("redactObject entra en las listas", () => {
  it("un DNI dentro de un array de objetos no se salva", () => {
    /*
     * Los arrays estaban excluidos con un `!Array.isArray(value)` explícito, y
     * justo ahí viaja lo que consulta el agente:
     *
     *   tools: [{ tool: "polizas_por_dni", args: { dni: "25.888.101" } }]
     *
     * O sea que el documento entraba entero al `audit_log`.
     */
    const limpio = redactObject({
      tools: [{ tool: "polizas_por_dni", args: { dni: "25.888.101" } }],
    }) as { tools: Array<{ tool: string; args: { dni: string } }> };

    expect(limpio.tools[0].args.dni).toBe("[DNI]");
  });

  it("las CLAVES sobreviven: se sigue sabiendo qué hizo", () => {
    // Es lo que hace que la entrada siga sirviendo. Sin los nombres, el registro
    // de por qué el agente hizo algo no dice nada.
    const limpio = redactObject({
      resolved: [{ field: "policy_number", value: "póliza 0000-9999" }],
    }) as { resolved: Array<{ field: string; value: string }> };

    expect(limpio.resolved[0].field).toBe("policy_number");
    expect(limpio.resolved[0].value).toContain("[POLIZA]");
  });

  it("y una lista de cadenas sueltas también", () => {
    const limpio = redactObject({ campos: ["DNI 25.888.101", "sin novedad"] }) as {
      campos: string[];
    };

    expect(limpio.campos[0]).toContain("[DNI]");
    expect(limpio.campos[1]).toBe("sin novedad");
  });
});
