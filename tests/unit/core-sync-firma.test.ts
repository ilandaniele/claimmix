/**
 * La firma del webhook al Core y el verificador que copia la aseguradora
 * (`docs/entrega-al-core/verificar-firma.mjs`). Si alguno de los dos cambia
 * sin el otro, el receptor rechaza todo: por eso el test usa el archivo de la
 * documentación y no una copia.
 */

import { describe, expect, it } from "vitest";

import { encabezadoDeFirma, firmar } from "@/server/core-sync/firma";
import { verificarFirma } from "../../docs/entrega-al-core/verificar-firma.mjs";

const SECRETO = "test-core-signing-secret";
const TS = 1_700_000_000;
const BODY = '{"caseId":"00000000-0000-4000-8000-000000000000"}';

function firmado(secreto = SECRETO, ts = TS, body = BODY) {
  return encabezadoDeFirma(ts, firmar(secreto, ts, body));
}

describe("firmar", () => {
  it("coincide con un vector fijo", () => {
    expect(firmar(SECRETO, TS, BODY)).toBe("79713f13b7eff84a940d03fd9866b17a8c9ebd828f81ea3eb36640ac60c27889");
    expect(firmado()).toBe(`t=${TS},v1=79713f13b7eff84a940d03fd9866b17a8c9ebd828f81ea3eb36640ac60c27889`);
  });
});

describe("verificarFirma (docs/entrega-al-core)", () => {
  const base = { secreto: SECRETO, encabezado: firmado(), body: BODY, ahora: TS };

  it("acepta lo que produce firmar, como string y como Buffer", () => {
    expect(verificarFirma(base)).toBe(true);
    expect(verificarFirma({ ...base, body: Buffer.from(BODY) })).toBe(true);
  });

  it("rechaza un byte cambiado en el cuerpo", () => {
    const cambiado = BODY.replace('0000"}', '0001"}');
    expect(cambiado).not.toBe(BODY);
    expect(verificarFirma({ ...base, body: cambiado })).toBe(false);
  });

  it("rechaza otro secreto", () => {
    expect(verificarFirma({ ...base, secreto: "test-other-signing-secret" })).toBe(false);
  });

  it("rechaza un ts fuera de los 5 minutos, para los dos lados", () => {
    expect(verificarFirma({ ...base, ahora: TS + 301 })).toBe(false);
    expect(verificarFirma({ ...base, ahora: TS - 301 })).toBe(false);
    expect(verificarFirma({ ...base, ahora: TS + 300 })).toBe(true);
  });

  it.each([
    ["vacío", ""],
    ["sin v1", `t=${TS}`],
    ["sin t", `v1=${"0".repeat(64)}`],
    ["t no numérico", `t=abc,v1=${"0".repeat(64)}`],
    ["v1 no hex", `t=${TS},v1=${"z".repeat(64)}`],
    ["basura", "no es una firma"],
  ])("rechaza un encabezado malformado (%s) sin tirar", (_, encabezado) => {
    expect(() => verificarFirma({ ...base, encabezado })).not.toThrow();
    expect(verificarFirma({ ...base, encabezado })).toBe(false);
  });

  it("rechaza una firma de otro largo sin tirar", () => {
    const corta = `t=${TS},v1=${firmar(SECRETO, TS, BODY).slice(0, 62)}`;
    expect(() => verificarFirma({ ...base, encabezado: corta })).not.toThrow();
    expect(verificarFirma({ ...base, encabezado: corta })).toBe(false);
  });

  it("rechaza tipos que no son los esperados sin tirar", () => {
    expect(verificarFirma({ ...base, encabezado: undefined as unknown as string })).toBe(false);
    expect(verificarFirma({ ...base, body: { caseId: "x" } as unknown as string })).toBe(false);
    expect(verificarFirma({ ...base, secreto: "" })).toBe(false);
  });
});
