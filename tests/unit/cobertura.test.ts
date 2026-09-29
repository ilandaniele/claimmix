/**
 * ¿La póliza cubre el siniestro? (B6)
 *
 * La vara es el día del SINIESTRO, no hoy; un dato que falta da «dudoso», nunca
 * «cubre»; y sólo lo que contradice la póliza da «no cubre».
 */

import { describe, expect, it } from "vitest";

import { evaluarCobertura, type Cotejo, type PolizaParaCobertura } from "@/core/case/cobertura";

const POLIZA: PolizaParaCobertura = {
  status: "active",
  start_date: "2026-01-01",
  end_date: "2026-12-31",
  coberturas: [
    { codigo: "rc", suma_asegurada: 50_000_000, franquicia: null },
    { codigo: "danio_parcial", suma_asegurada: 10_000_000, franquicia: 500_000 },
    { codigo: "danio_total", suma_asegurada: 10_000_000, franquicia: null },
  ],
  ambito_territorial: { tipo: "nacional", provincias: [] },
  patentes: ["AB123CD"],
};

const COTEJO: Cotejo = {
  poliza: POLIZA,
  tipo: "choque",
  fechaDelSiniestro: "2026-06-15",
  provincia: "Buenos Aires",
  patente: "ab 123 cd",
  monto: { minimo: 1_500_000, maximo: 5_000_000, moneda: "ARS", origen: "tabla" },
};

const con = (cambios: Partial<Cotejo>, poliza: Partial<PolizaParaCobertura> = {}) =>
  evaluarCobertura({ ...COTEJO, ...cambios, poliza: { ...POLIZA, ...poliza } });

describe("evaluarCobertura", () => {
  it("con todo en regla, cubre y sin motivos", () => {
    expect(evaluarCobertura(COTEJO)).toEqual({ veredicto: "cubre", motivos: [] });
  });

  it("compara contra la fecha del siniestro, no contra hoy", () => {
    // Una póliza vencida hace meses cubre un choque de cuando estaba vigente.
    expect(con({ fechaDelSiniestro: "2025-03-10" }, { start_date: "2025-01-01", end_date: "2025-12-31" }).veredicto).toBe(
      "cubre"
    );
    expect(con({ fechaDelSiniestro: "2027-01-02" })).toEqual({ veredicto: "no_cubre", motivos: ["fuera_de_vigencia"] });
    expect(con({ fechaDelSiniestro: "15/06/2025" }).motivos).toContain("fuera_de_vigencia");
  });

  it("sin fecha del siniestro no decide", () => {
    expect(con({ fechaDelSiniestro: null })).toEqual({ veredicto: "dudoso", motivos: ["sin_fecha"] });
  });

  it("el estado de hoy sólo marca la duda", () => {
    expect(con({}, { status: "cancelled" })).toEqual({ veredicto: "dudoso", motivos: ["poliza_no_activa"] });
  });

  it("sin póliza o sin coberturas leídas, dudoso", () => {
    expect(evaluarCobertura({ ...COTEJO, poliza: null })).toEqual({
      veredicto: "dudoso",
      motivos: ["sin_coberturas_cargadas"],
    });
    expect(con({}, { coberturas: null }).motivos).toEqual(["sin_coberturas_cargadas"]);
  });

  it("un tipo sin cobertura no cubre; con una cobertura «otro», queda en duda", () => {
    expect(con({ tipo: "granizo" })).toEqual({ veredicto: "no_cubre", motivos: ["sin_cobertura_para_el_tipo"] });
    const conOtro = con(
      { tipo: "granizo" },
      { coberturas: [{ codigo: "otro", suma_asegurada: null, franquicia: null }] }
    );
    expect(conOtro).toEqual({ veredicto: "dudoso", motivos: ["sin_cobertura_para_el_tipo"] });
    expect(con({ tipo: null }).veredicto).toBe("dudoso");
  });

  it("una cobertura que alcanza sólo una parte del tipo deja la duda, no cubre ni descarta", () => {
    const soloTotal = { coberturas: [{ codigo: "danio_total", suma_asegurada: null, franquicia: null }] };
    const soloRc = { coberturas: [{ codigo: "rc", suma_asegurada: null, franquicia: null }] };
    const soloPartes = { coberturas: [{ codigo: "robo_parcial", suma_asegurada: null, franquicia: null }] };
    const dudoso = { veredicto: "dudoso", motivos: ["cobertura_segun_alcance"] };
    expect(con({}, soloTotal)).toEqual(dudoso);
    expect(con({}, soloRc)).toEqual(dudoso);
    expect(con({ tipo: "robo" }, soloPartes)).toEqual(dudoso);
    expect(con({ tipo: "granizo" }, soloRc)).toEqual({ veredicto: "no_cubre", motivos: ["sin_cobertura_para_el_tipo"] });
  });

  it("fuera del ámbito provincial no cubre; sin provincia, dudoso", () => {
    const ambito = { ambito_territorial: { tipo: "provincias", provincias: ["Córdoba", "CABA"] } };
    expect(con({ provincia: "Mendoza" }, ambito)).toEqual({ veredicto: "no_cubre", motivos: ["fuera_del_ambito"] });
    expect(con({ provincia: "cordoba" }, ambito).veredicto).toBe("cubre");
    expect(con({ provincia: "Capital Federal" }, ambito).veredicto).toBe("cubre");
    expect(con({ provincia: null }, ambito)).toEqual({ veredicto: "dudoso", motivos: ["sin_lugar"] });
    expect(con({ provincia: "Bs As" }, ambito)).toEqual({ veredicto: "dudoso", motivos: ["sin_lugar"] });
  });

  it("un ámbito mal leído o que no distingue capital de provincia deja la duda", () => {
    const dudoso = { veredicto: "dudoso", motivos: ["ambito_dudoso"] };
    const lista = (provincias: string[]) => ({ ambito_territorial: { tipo: "provincias", provincias } });
    expect(con({ provincia: "Mendoza" }, lista([]))).toEqual(dudoso);
    expect(con({ provincia: "Mendoza" }, lista(["Cordoba", "Cuyo"]))).toEqual(dudoso);
    expect(con({ provincia: "Buenos Aires" }, lista(["CABA"]))).toEqual(dudoso);
    expect(con({ provincia: "CABA" }, lista(["Buenos Aires"]))).toEqual(dudoso);
  });

  it("una patente que no es de la póliza se marca, no decide", () => {
    expect(con({ patente: "ZZ999ZZ" })).toEqual({ veredicto: "dudoso", motivos: ["vehiculo_no_coincide"] });
    expect(con({ patente: null }).veredicto).toBe("cubre");
    expect(con({}, { patentes: [] }).veredicto).toBe("cubre");
  });

  it("marca el monto bajo la franquicia o sobre la suma asegurada", () => {
    expect(con({ monto: { minimo: 100_000, maximo: 400_000, moneda: "ARS", origen: "tabla" } }).motivos).toEqual([
      "bajo_franquicia",
    ]);
    expect(con({ monto: { minimo: 15_000_000, maximo: 40_000_000, moneda: "ARS", origen: "tabla" } }).motivos).toEqual([
      "supera_suma_asegurada",
    ]);
  });

  it("una cobertura rota se descarta o queda como «otro», no rompe", () => {
    const r = con({}, { coberturas: [{ codigo: 7 }, "basura", ...(POLIZA.coberturas as unknown[])] });
    expect(r.veredicto).toBe("cubre");
  });

  it("junta los motivos en orden fijo y gana el grave", () => {
    const r = con({ fechaDelSiniestro: "2027-05-01", patente: "ZZ999ZZ" }, { status: "expired" });
    expect(r).toEqual({ veredicto: "no_cubre", motivos: ["poliza_no_activa", "fuera_de_vigencia", "vehiculo_no_coincide"] });
  });
});
