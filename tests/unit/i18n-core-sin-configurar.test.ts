/**
 * El panel de envío sin integración lo ve cualquiera que abra el caso, y el
 * botón «Entregado por fuera» sólo quien puede cambiar el estado. El texto de
 * todos no puede mandar a un botón que un viewer no tiene; la pista va aparte
 * y nombra el botón como se llama.
 */

import { describe, it, expect } from "vitest";
import { esAR } from "@/lib/i18n/es-AR";
import { enUS } from "@/lib/i18n/en-US";

describe.each([
  ["es-AR", esAR],
  ["en-US", enUS],
])("panel sin integración con Core (%s)", (_, dict) => {
  const boton = dict["case.detail.entregadoPorFuera"].split(":")[0]!;

  it("el texto de todos no nombra el botón", () => {
    expect(dict["case.detail.coreSyncSinConfigurar"]).not.toContain(boton);
  });

  it("la pista para quien tiene permiso nombra el botón", () => {
    expect(dict["case.detail.coreSyncEntregadoPorFuera"]).toContain(boton);
  });
});
