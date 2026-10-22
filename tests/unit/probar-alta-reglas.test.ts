/**
 * Las reglas de `pnpm alta:probar`, sin red ni base.
 *
 * Lo que decide si el Post-deploy de QA queda rojo vive acá: un rojo tiene que
 * querer decir «el alta se rompió» y no «la red parpadeó», y los logs de Actions
 * son públicos, así que ningún texto lleva un dato.
 */

import { describe, expect, it } from "vitest";

import { isReservedTestNumber } from "@/core/phone/reserved";
import { llegoAlAviso } from "@/server/alta/aviso-operador";
import { normalizarE164, validarEmpresa } from "@/server/alta/validar";

import {
  CUPOS_DE_LA_RED_DE_PRUEBA,
  CUPOS_ESPERADOS,
  HALLAZGOS,
  LETRAS,
  NOMBRES_DE_TOPES,
  PREFIJO_CORREO,
  PREFIJO_EMPRESA,
  clasificarError,
  codigoDeDestinoInesperado,
  compararContadores,
  correoDe,
  diagnosticarCierre,
  empresaDe,
  esCorrida,
  esFallaTragada,
  formatear,
  hallazgo,
  ipDe,
  leerSalud,
  margenDelTope,
  numeroDe,
  revisarEnlaceAjeno,
  revisarRegistro,
  topesDesdeBanderas,
  veredicto,
  veredictoDelBarrido,
  type CodigoDeHallazgo,
  type Letra,
} from "../../scripts/lib/probar-alta-reglas.mjs";

const CODIGOS = Object.keys(HALLAZGOS) as CodigoDeHallazgo[];
const TODAS_LAS_LETRAS = Object.keys(LETRAS) as Letra[];

/** Corridas repartidas por todo el rango de seis dígitos, sin azar para que el test no varíe. */
function corridas(cuantas: number): string[] {
  const salida = ["000000", "ffffff", "0f4240", "0000fd", "0000fe", "0000ff"];
  for (let i = 0; salida.length < cuantas; i++) {
    salida.push((((i + 1) * 16_777_259 + 12_345) % 16_777_216).toString(16).padStart(6, "0"));
  }
  return salida;
}

describe("la tabla de hallazgos", () => {
  it("cada código tiene nivel y texto, y el texto no lleva datos", () => {
    expect(CODIGOS.length).toBeGreaterThan(0);
    for (const c of CODIGOS) {
      const h = hallazgo(c);
      expect(h.codigo).toBe(c);
      expect(["bien", "inconcluso", "rojo"]).toContain(h.nivel);
      expect(h.texto.trim().length).toBeGreaterThan(0);
      expect(h.texto).not.toContain("@");
      expect(h.texto.toLowerCase()).not.toContain("postgres");
      expect(h.texto).not.toMatch(/[0-9]{4,}/);
      expect(h.texto).not.toMatch(/::|\n/);
    }
  });

  it("los niveles son los del contrato", () => {
    const por = (n: string) => CODIGOS.filter((c) => HALLAZGOS[c].nivel === n).sort();
    expect(por("bien")).toEqual(
      [
        "salud_ok",
        "registro_ok",
        "enlace_ajeno_rechazado",
        "margen_ok",
        "enlace_ok",
        "enlace_viejo_ok",
        "alta_ok",
        "segunda_vez_ok",
        "contadores_ok",
        "cupo_devuelto",
        "tope_por_ip_ok",
        "barrido_ok",
      ].sort()
    );
    expect(por("inconcluso")).toEqual(
      [
        "no_contesta",
        "salud_ilegible",
        "otro_commit",
        "base_por_cliente_prendida",
        "registro_no_contesta",
        "enlace_no_contesta",
        "candado_ocupado",
        "tope_lleno",
        "cerca_del_aviso",
        "numero_ocupado",
        "contador_movido",
        "contador_sin_respuesta",
        "pasajero",
        "barrido_sin_candado",
        "barrido_pasajero",
      ].sort()
    );
    expect(por("rojo")).toEqual(
      [
        "sin_permiso",
        "sin_banderas",
        "alta_apagada",
        "registro_sin_formulario",
        "registro_pide_empresa",
        "registro_correo_incoherente",
        "registro_turnstile_incoherente",
        "token_ajeno_aceptado",
        "enlace_ilegible",
        "tope_0",
        "destino_inesperado",
        "enlace_creo_espacio",
        "correo_sin_verificar",
        "sin_perfil_de_dueno",
        "inquilino_mal_creado",
        "sin_numero",
        "sin_auditoria",
        "sin_sesion",
        "cupos_mal_contados",
        "segunda_vez_creo_algo",
        "cupo_no_devuelto",
        "tope_por_ip_no_corta",
        "migracion_pendiente",
        "tope_de_bases",
        "tope_de_mb",
        "alta_cerrada_sin_conteo",
        "resultado_inesperado",
        "error_pg",
        "error",
        "residuo",
        "barrido_fallo",
      ].sort()
    );
  });

  it("formatear pone la anotación de Actions que corresponde al nivel", () => {
    expect(formatear(hallazgo("tope_0"))).toBe(`::error::alta: tope_0 — ${HALLAZGOS.tope_0.texto}`);
    expect(formatear(hallazgo("tope_lleno"))).toBe(`::warning::alta: tope_lleno — ${HALLAZGOS.tope_lleno.texto}`);
    expect(formatear(hallazgo("alta_ok"))).toBe(`alta: alta_ok — ${HALLAZGOS.alta_ok.texto}`);
  });
});

describe("la identidad de la corrida", () => {
  const MUESTRA = corridas(1000);

  it("esCorrida pide seis dígitos hexadecimales en minúscula", () => {
    expect(esCorrida("0f4240")).toBe(true);
    expect(esCorrida("ABCDEF")).toBe(false);
    expect(esCorrida("12345")).toBe(false);
    expect(esCorrida("1234567")).toBe(false);
    expect(esCorrida("12345g")).toBe(false);
    expect(esCorrida(undefined)).toBe(false);
    expect(esCorrida(123456)).toBe(false);
  });

  it("las cinco IPs de una corrida son distintas, del bloque de prueba y válidas", () => {
    for (const c of MUESTRA) {
      const ips = TODAS_LAS_LETRAS.map((l) => ipDe(c, l));
      expect(new Set(ips).size).toBe(5);
      for (const ip of ips) {
        expect(ip).toMatch(/^203\.0\.113\.[0-9]{1,3}$/);
        const ultimo = Number(ip.split(".")[3]);
        expect(ultimo).toBeGreaterThanOrEqual(1);
        expect(ultimo).toBeLessThanOrEqual(254);
        expect(CUPOS_DE_LA_RED_DE_PRUEBA.test(ip)).toBe(true);
        expect(CUPOS_DE_LA_RED_DE_PRUEBA.test(`alta:ip:${ip}`)).toBe(true);
      }
    }
  });

  it("las letras se desplazan a partir de la base de la corrida", () => {
    expect(ipDe("000000", "g")).toBe("203.0.113.1");
    expect(ipDe("000000", "a")).toBe("203.0.113.2");
    expect(ipDe("000000", "b")).toBe("203.0.113.3");
    expect(ipDe("000000", "r")).toBe("203.0.113.4");
    expect(ipDe("000000", "v")).toBe("203.0.113.5");
    // 0xfd = 253: la base más alta, y las demás dan la vuelta.
    expect(ipDe("0000fd", "g")).toBe("203.0.113.254");
    expect(ipDe("0000fd", "a")).toBe("203.0.113.1");
    expect(ipDe("0000fd", "b")).toBe("203.0.113.2");
    expect(ipDe("0000fd", "r")).toBe("203.0.113.3");
    expect(ipDe("0000fd", "v")).toBe("203.0.113.4");
  });

  it("la red de prueba no incluye otras redes", () => {
    for (const ajena of ["203.0.114.5", "203.0.113", "1203.0.113.5", "alta:ip:203.0.113.5.6", "10.0.0.1"]) {
      expect(CUPOS_DE_LA_RED_DE_PRUEBA.test(ajena)).toBe(false);
    }
  });

  it("los cinco números son distintos, válidos y del bloque que no es de nadie", () => {
    for (const c of MUESTRA) {
      const numeros = TODAS_LAS_LETRAS.map((l) => numeroDe(c, l));
      expect(new Set(numeros).size).toBe(5);
      for (const n of numeros) {
        expect(n).toMatch(/^\+[1-9][0-9]{7,14}$/);
        expect(normalizarE164(n)).toBe(n);
        expect(n.startsWith("+5490000")).toBe(true);
        expect(isReservedTestNumber(n)).toBe(true);
      }
    }
    expect(numeroDe("0f4240", "g")).toBe("+54900000000001");
    expect(numeroDe("0f4240", "r")).toBe("+54900000000004");
    expect(numeroDe("0f4240", "v")).toBe("+54900000000005");
  });

  it("el correo y la empresa llevan el prefijo con el que el barrido los elige", () => {
    for (const c of MUESTRA) {
      for (const l of TODAS_LAS_LETRAS) {
        expect(correoDe(c, l)).toBe(`${PREFIJO_CORREO}${c}-${l}@example.com`);
        expect(correoDe(c, l)).toMatch(/^alta-probar-[0-9a-f]{6}-[gabrv]@example\.com$/);
        const empresa = empresaDe(c, l);
        expect(empresa.startsWith(PREFIJO_EMPRESA)).toBe(true);
        expect(empresa.length).toBeGreaterThanOrEqual(2);
        expect(empresa.length).toBeLessThanOrEqual(80);
        expect(empresa).not.toContain("@");
        expect(empresa).not.toContain("://");
        expect(validarEmpresa(empresa)).toEqual({ ok: true, empresa });
      }
    }
  });

  it("una corrida mal formada no inventa una identidad", () => {
    for (const mala of ["", "xyz", "12345", "ZZZZZZ", "0f4240; drop"]) {
      expect(() => ipDe(mala, "g")).toThrow();
      expect(() => numeroDe(mala, "g")).toThrow();
      expect(() => correoDe(mala, "g")).toThrow();
      expect(() => empresaDe(mala, "g")).toThrow();
    }
  });
});

describe("topesDesdeBanderas", () => {
  it("pasa un número finito a texto y todo lo demás a vacío", () => {
    expect(
      topesDesdeBanderas({
        ALTA_TOPE_GLOBAL_DIA: 20,
        ALTA_TOPE_BASES: 0,
        ALTA_TOPE_MB: null,
        ALTA_TOPE_IP_DIA: "3",
        ALTA_PRUEBA_DIAS: Number.NaN,
      })
    ).toEqual({
      ALTA_TOPE_GLOBAL_DIA: "20",
      ALTA_TOPE_BASES: "0",
      ALTA_TOPE_MB: "",
      ALTA_TOPE_IP_DIA: "",
      ALTA_PRUEBA_DIAS: "",
    });
  });

  it("devuelve siempre las cinco claves, también sin banderas, y nunca un infinito", () => {
    const vacio = topesDesdeBanderas({});
    expect(Object.keys(vacio).sort()).toEqual([...NOMBRES_DE_TOPES].sort());
    expect(Object.values(vacio).every((v) => v === "")).toBe(true);
    expect(topesDesdeBanderas({ ALTA_TOPE_MB: Number.POSITIVE_INFINITY, ALTA_TOPE_IP_DIA: {} }).ALTA_TOPE_MB).toBe("");
    expect(topesDesdeBanderas({ ALTA_TOPE_IP_DIA: undefined }).ALTA_TOPE_IP_DIA).toBe("");
  });
});

describe("leerSalud", () => {
  const BANDERAS = { ALTA_AUTOMATICA: true, BASE_POR_CLIENTE: false };
  const codigos = (r: { hallazgos: { codigo: string }[] }) => r.hallazgos.map((h) => h.codigo);

  it("0 es que el despliegue no contestó", () => {
    expect(codigos(leerSalud(0, null))).toEqual(["no_contesta"]);
  });

  it("401 es que el secreto no sirve", () => {
    expect(codigos(leerSalud(401, { error: {} }))).toEqual(["sin_permiso"]);
  });

  it("cualquier otro código que no sea 200 ni 503 es ilegible", () => {
    for (const codigo of [404, 500, 502, 504, 302]) {
      const r = leerSalud(codigo, { banderas: BANDERAS });
      expect(codigos(r)).toEqual(["salud_ilegible"]);
      expect(r.banderas).toBeNull();
    }
  });

  it("sin objeto banderas, en 200 o en 503, no hay con qué seguir", () => {
    for (const codigo of [200, 503]) {
      for (const cuerpo of [null, "texto", [], {}, { banderas: null }, { banderas: [] }, { banderas: "x" }]) {
        const r = leerSalud(codigo, cuerpo);
        expect(codigos(r)).toEqual(["sin_banderas"]);
        expect(r.banderas).toBeNull();
      }
    }
  });

  it("el alta apagada o sin la bandera da alta_apagada y no devuelve banderas", () => {
    for (const banderas of [{ ALTA_AUTOMATICA: false }, {}, { ALTA_AUTOMATICA: "1" }, { ALTA_AUTOMATICA: 1 }]) {
      const r = leerSalud(200, { banderas });
      expect(codigos(r)).toEqual(["alta_apagada"]);
      expect(r.banderas).toBeNull();
    }
  });

  it("200 y 503 con banderas siguen, y devuelven las banderas", () => {
    for (const codigo of [200, 503]) {
      const r = leerSalud(codigo, { banderas: BANDERAS, commit: "abc1234" });
      expect(codigos(r)).toEqual(["salud_ok"]);
      expect(r.banderas).toEqual(BANDERAS);
    }
  });

  it("la base por cliente prendida sigue, como inconcluso", () => {
    const r = leerSalud(200, { banderas: { ...BANDERAS, BASE_POR_CLIENTE: true } });
    expect(codigos(r)).toEqual(["base_por_cliente_prendida"]);
    expect(r.banderas).not.toBeNull();
  });

  it("compara el commit contra los primeros siete del sha", () => {
    const sha = "abc1234def5678901234567890123456789abcde";
    expect(codigos(leerSalud(200, { banderas: BANDERAS, commit: "abc1234" }, sha))).toEqual(["salud_ok"]);
    expect(codigos(leerSalud(200, { banderas: BANDERAS, commit: "zzz9999" }, sha))).toEqual(["otro_commit"]);
    expect(codigos(leerSalud(200, { banderas: BANDERAS, commit: null }, sha))).toEqual(["otro_commit"]);
    expect(codigos(leerSalud(200, { banderas: BANDERAS }, sha))).toEqual(["otro_commit"]);
  });

  it("un sha corto se recorta igual, y sin sha no se compara", () => {
    expect(codigos(leerSalud(200, { banderas: BANDERAS, commit: "abc1234" }, "abc12"))).toEqual(["otro_commit"]);
    expect(codigos(leerSalud(200, { banderas: BANDERAS, commit: "abc12" }, "abc12"))).toEqual(["salud_ok"]);
    expect(codigos(leerSalud(200, { banderas: BANDERAS, commit: "cualquiera" }))).toEqual(["salud_ok"]);
    expect(codigos(leerSalud(200, { banderas: BANDERAS, commit: "cualquiera" }, ""))).toEqual(["salud_ok"]);
  });

  it("junta la base por cliente y el otro commit", () => {
    const r = leerSalud(503, { banderas: { ...BANDERAS, BASE_POR_CLIENTE: true }, commit: "zzz9999" }, "abc1234def");
    expect(codigos(r)).toEqual(["base_por_cliente_prendida", "otro_commit"]);
  });
});

describe("revisarRegistro", () => {
  const CAMPOS = '<input name="terminos">';
  const CORREO = '<input id="registro-correo" name="email">';
  const DESAFIO = '<div class="cf-turnstile" data-sitekey="x"></div>';
  const CON_CORREO = {
    ALTA_REMITENTE_CORREO: true,
    ALTA_REMITENTE_REFRESH_TOKEN: true,
    GMAIL_CLIENT_ID: true,
    GMAIL_CLIENT_SECRET: true,
  };
  const CON_TURNSTILE = { TURNSTILE_SITE_KEY: true, TURNSTILE_SECRET_KEY: true };
  const codigos = (hs: { codigo: string }[]) => hs.map((h) => h.codigo);

  it("un código distinto de 200 es que no contestó", () => {
    expect(codigos(revisarRegistro(500, CAMPOS, {}))).toEqual(["registro_no_contesta"]);
    expect(codigos(revisarRegistro(307, CAMPOS, {}))).toEqual(["registro_no_contesta"]);
  });

  it("sin los términos no hay formulario", () => {
    expect(codigos(revisarRegistro(200, "<main></main>", {}))).toEqual(["registro_sin_formulario"]);
  });

  it("pedir la empresa o el número en el registro es del alta de antes: los dos van en el segundo paso", () => {
    expect(codigos(revisarRegistro(200, CAMPOS + '<input name="empresa">', {}))).toEqual(["registro_pide_empresa"]);
    expect(codigos(revisarRegistro(200, CAMPOS + '<input name="whatsapp">', {}))).toEqual(["registro_pide_empresa"]);
    expect(codigos(revisarRegistro(200, CAMPOS + '<input name="empresa"><input name="whatsapp">', {}))).toEqual([
      "registro_pide_empresa",
    ]);
  });

  it("la matriz de correo y desafío contra lo que dicen las banderas", () => {
    for (const correo of [false, true]) {
      for (const turnstile of [false, true]) {
        for (const hayCorreo of [false, true]) {
          for (const hayDesafio of [false, true]) {
            const banderas = { ...(correo ? CON_CORREO : {}), ...(turnstile ? CON_TURNSTILE : {}) };
            const html = CAMPOS + (hayCorreo ? CORREO : "") + (hayDesafio ? DESAFIO : "");
            const esperado: string[] = [];
            if (hayCorreo !== correo) esperado.push("registro_correo_incoherente");
            // El desafío vive dentro del camino por correo: sin correo no se dibuja aunque haya claves.
            if (hayDesafio !== (correo && turnstile)) esperado.push("registro_turnstile_incoherente");
            expect(codigos(revisarRegistro(200, html, banderas))).toEqual(esperado.length ? esperado : ["registro_ok"]);
          }
        }
      }
    }
  });

  it("el correo cargado pide las cuatro banderas del remitente", () => {
    for (const falta of Object.keys(CON_CORREO)) {
      const banderas = { ...CON_CORREO, [falta]: false };
      expect(codigos(revisarRegistro(200, CAMPOS, banderas))).toEqual(["registro_ok"]);
      expect(codigos(revisarRegistro(200, CAMPOS + CORREO, banderas))).toEqual(["registro_correo_incoherente"]);
    }
  });

  it("el desafío cargado pide la clave del sitio y la secreta", () => {
    for (const falta of Object.keys(CON_TURNSTILE)) {
      const banderas = { ...CON_CORREO, ...CON_TURNSTILE, [falta]: false };
      expect(codigos(revisarRegistro(200, CAMPOS + CORREO, banderas))).toEqual(["registro_ok"]);
      expect(codigos(revisarRegistro(200, CAMPOS + CORREO + DESAFIO, banderas))).toEqual([
        "registro_turnstile_incoherente",
      ]);
    }
  });

  it("el campo de la etiqueta del correo no cuenta como el campo", () => {
    const html = CAMPOS + '<label for="registro-correo"></label><p id="registro-correo-ayuda"></p>';
    expect(codigos(revisarRegistro(200, html, {}))).toEqual(["registro_ok"]);
  });

  it("junta las incoherencias y sigue pidiendo el formulario", () => {
    expect(codigos(revisarRegistro(200, CORREO + DESAFIO, {}))).toEqual([
      "registro_sin_formulario",
      "registro_correo_incoherente",
      "registro_turnstile_incoherente",
    ]);
  });
});

describe("revisarEnlaceAjeno", () => {
  it("un código distinto de 200 es que no contestó", () => {
    expect(revisarEnlaceAjeno(500, '<a href="/registro">').codigo).toBe("enlace_no_contesta");
    expect(revisarEnlaceAjeno(302, "").codigo).toBe("enlace_no_contesta");
  });

  it("pedir la clave con un enlace ajeno es aceptarlo", () => {
    const html = '<input name="password"><a href="/registro">';
    expect(revisarEnlaceAjeno(200, html).codigo).toBe("token_ajeno_aceptado");
  });

  it("«vencido» con la vuelta a /registro es el rechazo que se espera", () => {
    expect(revisarEnlaceAjeno(200, '<a href="/registro">Pedir otro</a>').codigo).toBe("enlace_ajeno_rechazado");
  });

  it("cualquier otra cosa no se entiende", () => {
    expect(revisarEnlaceAjeno(200, "<main>otra cosa</main>").codigo).toBe("enlace_ilegible");
    expect(revisarEnlaceAjeno(200, "").codigo).toBe("enlace_ilegible");
  });
});

describe("clasificarError", () => {
  it("los códigos de conexión y de servidor caído son pasajeros", () => {
    for (const codigo of ["08006", "08000", "08P01", "57P01", "57P02", "57P03", "57014", "53300", "40001", "40P01", "55P03"]) {
      expect(clasificarError(codigo, "x")).toBe("pasajero");
    }
  });

  it("los mensajes de transporte son pasajeros, con o sin código", () => {
    for (const mensaje of [
      "read ECONNRESET",
      "connect ETIMEDOUT",
      "connect ECONNREFUSED",
      "getaddrinfo ENOTFOUND host",
      "getaddrinfo EAI_AGAIN host",
      "UND_ERR_SOCKET",
      "TypeError: fetch failed",
      "socket hang up",
      "WebSocket was closed before the connection was established",
      "Connection terminated unexpectedly",
      "Error connecting to database: x",
      "econnreset",
    ]) {
      expect(clasificarError(undefined, mensaje)).toBe("pasajero");
    }
    expect(clasificarError("23505", "ECONNRESET")).toBe("pasajero");
  });

  it("cualquier otro código de cinco caracteres es de la base", () => {
    for (const codigo of ["23505", "42883", "42501", "23503", "22P02"]) {
      expect(clasificarError(codigo, "mensaje")).toBe("pg");
    }
  });

  it("lo demás es otro", () => {
    expect(clasificarError(undefined, "Cannot read properties of undefined")).toBe("otro");
    expect(clasificarError(undefined, new TypeError("x is not a function").message)).toBe("otro");
    expect(clasificarError("ENOENT", "no such file")).toBe("otro");
    expect(clasificarError("", "")).toBe("otro");
  });
});

describe("codigoDeDestinoInesperado", () => {
  // Los módulos tragan los errores y devuelven un destino: «falla» en /alta, o /login si la cuenta se creó y no abrió la sesión.
  const TRAGADAS = ["/alta?e=falla", "/alta/correo?t=abc&e=falla", "/login"];
  const QUE_NO_CORRESPONDEN = [
    "/alta",
    "/bandeja",
    "/login?aviso=ya_tenes_cuenta",
    "/login?error=registro_cerrado",
    "/alta?e=intentos",
    "/alta?e=cerrada",
    "/alta?e=datos",
    "/alta/correo?t=abc&e=clave",
    "/alta/correo?t=abc&e=intentos",
    "/preparando",
  ];

  it("una falla que el módulo tragó con la base caída es «no se pudo probar» y no «se rompió»", () => {
    for (const destino of TRAGADAS) {
      expect(esFallaTragada(destino)).toBe(true);
      expect(codigoDeDestinoInesperado(destino, false)).toBe("pasajero");
    }
  });

  it("una falla tragada con la base arriba es un defecto: no se esconde como inconcluso", () => {
    for (const destino of TRAGADAS) {
      expect(codigoDeDestinoInesperado(destino, true)).toBe("destino_inesperado");
    }
  });

  it("cualquier otro destino que no se esperaba sigue en rojo, conteste la base o no", () => {
    for (const destino of QUE_NO_CORRESPONDEN) {
      expect(esFallaTragada(destino)).toBe(false);
      expect(codigoDeDestinoInesperado(destino, false)).toBe("destino_inesperado");
      expect(codigoDeDestinoInesperado(destino, true)).toBe("destino_inesperado");
    }
  });

  it("«falla» tiene que ser el último parámetro: uno que la lleve en medio no se confunde", () => {
    expect(esFallaTragada("/alta/correo?e=falla&t=abc")).toBe(false);
    expect(esFallaTragada("/alta?e=fallar")).toBe(false);
  });

  it("el pasajero no pone rojo el Post-deploy y el destino inesperado sí", () => {
    expect(hallazgo("pasajero").nivel).toBe("inconcluso");
    expect(hallazgo("destino_inesperado").nivel).toBe("rojo");
    expect(veredicto([hallazgo(codigoDeDestinoInesperado("/alta?e=falla", false))]).salida).toBe(0);
    expect(veredicto([hallazgo(codigoDeDestinoInesperado("/alta?e=falla", true))]).salida).toBe(1);
    expect(veredicto([hallazgo(codigoDeDestinoInesperado("/login?error=registro_cerrado", false))]).salida).toBe(1);
  });
});

describe("diagnosticarCierre", () => {
  const SANO = { funcion: true, objetos: true, topeBases: 0, bases: 0, topeMb: 0, mb: 0 };

  it("sin la función o sin los objetos falta la migración, antes que cualquier tope", () => {
    expect(diagnosticarCierre({ ...SANO, funcion: false })).toBe("migracion_pendiente");
    expect(diagnosticarCierre({ ...SANO, objetos: false })).toBe("migracion_pendiente");
    expect(
      diagnosticarCierre({ funcion: false, objetos: true, topeBases: 1, bases: 5, topeMb: 1, mb: 5 })
    ).toBe("migracion_pendiente");
  });

  it("el tope de bases va antes que el de MB", () => {
    const lleno = { ...SANO, topeBases: 5, bases: 5, topeMb: 100, mb: 100 };
    expect(diagnosticarCierre(lleno)).toBe("tope_de_bases");
    expect(diagnosticarCierre({ ...lleno, bases: 4 })).toBe("tope_de_mb");
    expect(diagnosticarCierre({ ...lleno, bases: 9 })).toBe("tope_de_bases");
  });

  it("un tope en cero no corta nunca", () => {
    expect(diagnosticarCierre({ ...SANO, bases: 99, mb: 99 })).toBe("posible_23505");
  });

  it("con todo en orden y por debajo de los topes, es un 23505", () => {
    expect(diagnosticarCierre({ ...SANO, topeBases: 5, bases: 4, topeMb: 100, mb: 99 })).toBe("posible_23505");
  });
});

describe("margenDelTope", () => {
  it("con el tope 20 de omisión hay margen hasta 13 altas", () => {
    expect(margenDelTope(0, 20, llegoAlAviso).codigo).toBe("margen_ok");
    expect(margenDelTope(13, 20, llegoAlAviso).codigo).toBe("margen_ok");
  });

  it("desde 14 la prueba mismo más un alta de verdad llegan al aviso del 80 %", () => {
    expect(margenDelTope(14, 20, llegoAlAviso).codigo).toBe("cerca_del_aviso");
    expect(margenDelTope(19, 20, llegoAlAviso).codigo).toBe("cerca_del_aviso");
  });

  it("con el día lleno no hay lugar para una alta más", () => {
    expect(margenDelTope(20, 20, llegoAlAviso).codigo).toBe("tope_lleno");
    expect(margenDelTope(25, 20, llegoAlAviso).codigo).toBe("tope_lleno");
  });

  it("el tope 0 es el alta cerrada por configuración", () => {
    expect(margenDelTope(0, 0, llegoAlAviso).codigo).toBe("tope_0");
    expect(margenDelTope(5, 0, llegoAlAviso).codigo).toBe("tope_0");
  });

  it("usa el llegoAlAviso que se le da, con c + 2", () => {
    const llamadas: [number, number][] = [];
    const h = margenDelTope(7, 40, (c, t) => {
      llamadas.push([c, t]);
      return false;
    });
    expect(h.codigo).toBe("margen_ok");
    expect(llamadas).toEqual([[9, 40]]);
    expect(margenDelTope(7, 40, () => true).codigo).toBe("cerca_del_aviso");
  });
});

describe("CUPOS_ESPERADOS", () => {
  it("son acumulados desde antes del primer paso: el enlace gasta la red y no el cupo del alta", () => {
    expect(CUPOS_ESPERADOS.enlace).toEqual({ "auth:ip": 1, "alta:ip": 0 });
    expect(CUPOS_ESPERADOS.espacio).toEqual({ "auth:ip": 1, "alta:ip": 1 });
    expect(CUPOS_ESPERADOS.enlaceOtraVez).toEqual({ "auth:ip": 2, "alta:ip": 1 });
  });

  it("ningún contador baja de un escenario al siguiente", () => {
    const pasos = [CUPOS_ESPERADOS.enlace, CUPOS_ESPERADOS.espacio, CUPOS_ESPERADOS.enlaceOtraVez];
    for (const clave of ["auth:ip", "alta:ip"] as const) {
      for (let i = 1; i < pasos.length; i++) {
        expect(pasos[i]![clave]).toBeGreaterThanOrEqual(pasos[i - 1]![clave]);
      }
    }
  });

  it("un enlace que gastó el cupo del alta no pasa", () => {
    expect(compararContadores({}, { "auth:ip": 1 }, CUPOS_ESPERADOS.enlace).codigo).toBe("contadores_ok");
    expect(compararContadores({}, { "auth:ip": 1, "alta:ip": 1 }, CUPOS_ESPERADOS.enlace).codigo).toBe("cupos_mal_contados");
  });
});

describe("compararContadores", () => {
  it("compara lo que subió, no el valor absoluto", () => {
    const antes = { "auth:ip": 4, "alta:ip": 1 };
    const despues = { "auth:ip": 5, "alta:ip": 2 };
    expect(compararContadores(antes, despues, { "auth:ip": 1, "alta:ip": 1 }).codigo).toBe("contadores_ok");
    expect(compararContadores(antes, despues, { "auth:ip": 1, "alta:ip": 0 }).codigo).toBe("cupos_mal_contados");
    expect(compararContadores(antes, despues, { "auth:ip": 2 }).codigo).toBe("cupos_mal_contados");
  });

  it("un contador que no existía antes vale cero", () => {
    expect(compararContadores({}, { "alta:ip": 1 }, { "alta:ip": 1 }).codigo).toBe("contadores_ok");
    expect(compararContadores({}, {}, { "alta:ip": 0 }).codigo).toBe("contadores_ok");
    expect(compararContadores({}, {}, { "alta:ip": 1 }).codigo).toBe("cupos_mal_contados");
  });

  it("un cupo devuelto vuelve a cero de diferencia", () => {
    expect(compararContadores({ "alta:ip": 3 }, { "alta:ip": 3 }, { "alta:ip": 0 }).codigo).toBe("contadores_ok");
  });
});

describe("veredicto", () => {
  const h = (...c: CodigoDeHallazgo[]) => c.map(hallazgo);

  it("un rojo es rojo y sale con 1, aunque haya inconclusos", () => {
    expect(veredicto(h("alta_ok", "pasajero", "tope_0"))).toEqual({ resultado: "rojo", salida: 1 });
  });

  it("un inconcluso sin rojos sale con 0", () => {
    expect(veredicto(h("alta_ok", "tope_lleno"))).toEqual({ resultado: "inconcluso", salida: 0 });
  });

  it("todo en verde es probado", () => {
    expect(veredicto(h("salud_ok", "alta_ok", "barrido_ok"))).toEqual({ resultado: "probado", salida: 0 });
    expect(veredicto([])).toEqual({ resultado: "probado", salida: 0 });
  });
});

describe("veredictoDelBarrido", () => {
  it("sin candado no se pudo barrer, y no es rojo", () => {
    const r = veredictoDelBarrido({ candado: false, residuo: 3 });
    expect(r.hallazgo.codigo).toBe("barrido_sin_candado");
    expect(r.salida).toBe(0);
  });

  it("un error pasajero no es rojo", () => {
    const r = veredictoDelBarrido({ candado: true, error: "pasajero", residuo: 3 });
    expect(r.hallazgo.codigo).toBe("barrido_pasajero");
    expect(r.salida).toBe(0);
  });

  it("un error de la base o desconocido es rojo", () => {
    for (const error of ["pg", "otro"] as const) {
      const r = veredictoDelBarrido({ candado: true, error, residuo: 0 });
      expect(r.hallazgo.codigo).toBe("barrido_fallo");
      expect(r.salida).toBe(1);
    }
  });

  it("el residuo después de un barrido sin errores es rojo", () => {
    const r = veredictoDelBarrido({ candado: true, residuo: 1 });
    expect(r.hallazgo.codigo).toBe("residuo");
    expect(r.salida).toBe(1);
  });

  it("sin errores ni residuo, el barrido está bien", () => {
    const r = veredictoDelBarrido({ candado: true, residuo: 0 });
    expect(r.hallazgo.codigo).toBe("barrido_ok");
    expect(r.salida).toBe(0);
  });
});
