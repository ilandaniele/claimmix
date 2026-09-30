/**
 * Las reglas de la revisión nocturna (B22): los nombres, los plazos y cómo se
 * lee el dato que guarda cada una. Las cuentas van en SQL y se prueban en
 * `revision-nocturna.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  CANALES_SIMULADOS,
  clavesDelDato,
  DIAS_DE_VENTANA_DEL_CIERRE,
  HORAS_DERIVACION_SIN_RESPUESTA,
  HORAS_DOC_SIN_RECIBIR,
  REGLAS,
} from "@/core/desvios/reglas";
import { esAR as esARCliente } from "@/lib/i18n/es-AR";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";

describe("las reglas", () => {
  it("son las cinco del plan, sin repetir, con nombre de clave", () => {
    expect([...REGLAS]).toEqual([
      "doc_sin_recibir",
      "cierre_sin_listo",
      "derivacion_sin_respuesta",
      "plazo_vencido",
      "plan_sin_terminar",
    ]);
    expect(new Set(REGLAS).size).toBe(REGLAS.length);
    for (const r of REGLAS) expect(r).toMatch(/^[a-z_]+$/);
  });

  it("los plazos son los acordados: 72 h el documento, 24 h la derivación, 30 días la ventana del cierre", () => {
    expect(HORAS_DOC_SIN_RECIBIR).toBe(72);
    expect(HORAS_DERIVACION_SIN_RESPUESTA).toBe(24);
    expect(DIAS_DE_VENTANA_DEL_CIERRE).toBe(30);
  });

  it("los canales de ensayo quedan afuera", () => {
    expect([...CANALES_SIMULADOS]).toEqual(["email_sim", "whatsapp_sim"]);
  });

  it("cada regla tiene su título y su detalle, en castellano e inglés y sólo en el diccionario de servidor", () => {
    const camel = (r: string) => r.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    for (const r of REGLAS) {
      for (const clave of [`desvios.regla.${camel(r)}`, `desvios.detalle.${camel(r)}`]) {
        expect(esARServidor).toHaveProperty([clave]);
        expect(enUSServidor).toHaveProperty([clave]);
        // El navegador no tiene por qué bajarse un texto que sólo pinta el servidor.
        expect(esARCliente).not.toHaveProperty([clave]);
      }
    }
  });
});

describe("clavesDelDato", () => {
  it("separa por coma y recorta", () => {
    expect(clavesDelDato("fotos_danos, denuncia_policial")).toEqual(["fotos_danos", "denuncia_policial"]);
  });

  it("sin dato, no hay claves", () => {
    expect(clavesDelDato(null)).toEqual([]);
    expect(clavesDelDato("")).toEqual([]);
  });

  it("descarta lo que no tiene forma de clave en vez de mostrarlo", () => {
    expect(clavesDelDato("ok_1,<script>alert(1)</script>,Mayuscula,1empieza_con_numero,con espacio,otra")).toEqual([
      "ok_1",
      "otra",
    ]);
  });

  it("corta en diez claves", () => {
    const muchas = Array.from({ length: 25 }, (_, i) => `paso_${i}`).join(",");
    expect(clavesDelDato(muchas)).toHaveLength(10);
  });

  it("una clave de más de cuarenta caracteres no es una clave", () => {
    expect(clavesDelDato(`a${"b".repeat(40)},corta`)).toEqual(["corta"]);
    expect(clavesDelDato(`a${"b".repeat(39)}`)).toHaveLength(1);
  });
});
