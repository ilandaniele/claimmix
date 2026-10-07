/**
 * El mensaje no le dicta a la persona lo que sólo sabemos por el padrón.
 *
 * El agente busca la póliza por el DNI que escribió quien nos escribe. Si el
 * texto que sale repite el número de contrato que devolvió la consulta, un DNI
 * ajeno tecleado en WhatsApp alcanza para que el asegurador le entregue la
 * póliza de otro. El dato queda en la denuncia; lo que no sale es el texto.
 */

import { describe, it, expect } from "vitest";

import { repiteDatoDelPadron, tokensDelPadron } from "@/core/text/dato-del-padron";

const RESULTADO = '{"encontradas":1,"polizas":[{"numero":"POL-8812-R","tipo":"auto","vigente":true}]}';

describe("tokensDelPadron", () => {
  it("saca el número de póliza de lo que devolvió la consulta, normalizado y por su parte numérica", () => {
    expect(tokensDelPadron([RESULTADO])).toEqual(["pol8812r", "8812"]);
  });

  it("también las corridas de cuatro dígitos de un número con puntuación o sólo de dígitos", () => {
    const tokens = tokensDelPadron(['{"numero":"10458-8877"}', '{"numero":"POL8812R"}']);
    expect(tokens).toEqual(expect.arrayContaining(["104588877", "10458", "8877", "pol8812r", "8812"]));
  });

  it("una fecha no aporta su año: «2026» está en cualquier respuesta", () => {
    const tokens = tokensDelPadron(['{"vence":"2026-12-31","emitida":"31/12/2024"}']);
    expect(tokens).not.toContain("2026");
    expect(tokens).not.toContain("2024");
  });

  it("toma los números largos y los códigos con letras y dígitos", () => {
    const tokens = tokensDelPadron(["titular 27.654.321, patente AB123CD, póliza 10458877"]);
    expect(tokens).toEqual(expect.arrayContaining(["27654321", "ab123cd", "10458877"]));
  });

  it("deja afuera las palabras y los números cortos", () => {
    const tokens = tokensDelPadron(['{"vigente":true,"tipo":"auto","anio":2015,"cuotas":12}']);
    expect(tokens).toEqual([]);
  });

  it("no repite un token que aparece en dos fuentes", () => {
    expect(tokensDelPadron([RESULTADO, RESULTADO])).toEqual(["pol8812r", "8812"]);
  });
});

describe("repiteDatoDelPadron", () => {
  const tokens = tokensDelPadron([RESULTADO]);

  it("devuelve la póliza del padrón cuando el texto la dicta", () => {
    const texto = "Cecilia, encontramos tu póliza POL-8812-R. ¿Nos confirmás cuándo fue el choque?";
    expect(repiteDatoDelPadron(texto, tokens, ["Hola, soy Cecilia, DNI 27.654.321"])).toBe("pol8812r");
  });

  it("la encuentra aunque el modelo la reescriba con otra puntuación", () => {
    expect(repiteDatoDelPadron("Tu póliza pol 8812 r está vigente.", tokens, [])).toBe("pol8812r");
  });

  it("devuelve null cuando la póliza la escribió la persona", () => {
    const texto = "Gracias por la póliza POL-8812-R. ¿Nos confirmás cuándo fue el choque?";
    expect(repiteDatoDelPadron(texto, tokens, ["Mi póliza es POL-8812-R, choqué ayer"])).toBeNull();
  });

  it("devuelve null cuando el número ya viene en el piso o en lo que mostramos enmascarado", () => {
    const texto = "Confirmanos si tu póliza POL-8812-R es correcta, por favor.";
    expect(repiteDatoDelPadron(texto, tokens, ["Tenemos la póliza POL-8812-R en el sistema"])).toBeNull();
  });

  it("devuelve null cuando el texto no repite nada", () => {
    expect(
      repiteDatoDelPadron("Contanos qué pasó y mandanos fotos de los daños, por favor.", tokens, [])
    ).toBeNull();
  });

  it.each([
    "Tu póliza termina en 8812, ¿es esa?",
    "Es la 8812-R, ¿verdad?",
    "¿Es la póliza 8812 la del auto?",
  ])("la parte del número que dicta un fragmento también se rechaza: %s", (texto) => {
    expect(repiteDatoDelPadron(texto, tokens, ["Hola, soy Cecilia, DNI 27.654.321"])).toBe("8812");
  });

  it("y un fragmento que la persona escribió se le puede confirmar", () => {
    const texto = "Anoté que la póliza termina en 8812, ¿es correcto?";
    expect(repiteDatoDelPadron(texto, tokens, ["Mi póliza termina en 8812, choqué ayer"])).toBeNull();
  });

  it("el número de cuatro dígitos de una póliza sólo de dígitos también se rechaza", () => {
    const sinLetras = tokensDelPadron(['{"polizas":[{"numero":"10458-8877"}]}']);
    expect(repiteDatoDelPadron("Tu póliza termina en 8877.", sinLetras, [])).toBe("8877");
  });

  it("un número de cuatro dígitos no cuenta", () => {
    const sinLargos = tokensDelPadron(['{"numero":"8812","anio":2015}']);
    expect(sinLargos).toEqual([]);
    expect(repiteDatoDelPadron("Tu póliza 8812 está vigente, año 2015.", sinLargos, [])).toBeNull();
  });

  it("sin tokens no rechaza nada", () => {
    expect(repiteDatoDelPadron("POL-8812-R", [], [])).toBeNull();
  });
});
