/**
 * El aviso de que un número del alta automática se mira a mano.
 *
 * Una vez por día y motivo (cada número agregado a la WABA, o que pudo haber
 * entrado, o que quedó sin su webhook, el suyo), a cada
 * dirección de operación, sin datos de nadie, y sin romper nunca el pedido que
 * lo dispara.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  remitente: vi.fn(),
  enviar: vi.fn(),
  operadores: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/operator-emails", () => ({ operatorEmails: h.operadores }));
vi.mock("@/server/notify/remitente-sistema", () => ({
  remitenteDelSistema: h.remitente,
  enviarCorreoDelSistema: h.enviar,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.rateLimit, liberarCupo: h.liberarCupo }));

import { esAR, enUS } from "@/lib/i18n";
import { avisarNumeroEnRevision, type MotivoDeRevision } from "@/server/alta/aviso-operador";

const DIA_MS = 24 * 60 * 60_000;
const VENTANA = 1_700_000_000_000;
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTRO_TENANT = "22222222-2222-4222-8222-222222222222";

const MOTIVOS: MotivoDeRevision[] = [
  "sin_lugar",
  "ya_en_la_waba",
  "rechazo",
  "sin_dueno",
  "pais",
  "sin_nombre",
  "sin_fila",
  "sin_credencial",
  "agregado",
  "incierto",
  "de_otro_ambiente",
  "sin_webhook",
  "canje",
  "suscripcion",
  "registro",
  "revocada",
  "plantilla",
  "numero_ocupado",
  "cupo_semanal",
  "token_vencido",
  "pago_pendiente",
  "nombre_rechazado",
  "waba_huerfana",
  "cuenta_restringida",
  "secreto_invalido",
  "waba_restringida",
  "waba_bloqueada",
  "recordatorio",
  "baja_fallida",
];

/** Los motivos de la WABA propia y de la app propia que tienen un aviso por espacio y día (todos menos el tope semanal). */
const DE_LA_WABA_PROPIA_POR_ESPACIO = [
  "canje",
  "suscripcion",
  "registro",
  "revocada",
  "plantilla",
  "numero_ocupado",
  "token_vencido",
  "pago_pendiente",
  "nombre_rechazado",
  "waba_huerfana",
  "cuenta_restringida",
  "secreto_invalido",
  "waba_restringida",
  "waba_bloqueada",
  "recordatorio",
  "baja_fallida",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.remitente.mockReturnValue("alta@example.com");
  h.operadores.mockReturnValue(["ops@example.com", "dueno@example.com"]);
  h.rateLimit.mockResolvedValue({ allowed: true, remaining: 0, resetAt: 0, retryAfterSeconds: 0, ventana: VENTANA });
  h.liberarCupo.mockResolvedValue(undefined);
  h.enviar.mockResolvedValue({ enviado: true });
});

describe("avisarNumeroEnRevision", () => {
  it("toma un solo cupo por día y manda un mail a cada operador, con el motivo y sin el espacio", async () => {
    await avisarNumeroEnRevision("sin_lugar", TENANT);

    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).toHaveBeenCalledWith("alta:aviso-numero:sin_lugar", { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    expect(h.enviar).toHaveBeenCalledTimes(2);
    expect(h.enviar.mock.calls.map(([m]) => m.to)).toEqual(["ops@example.com", "dueno@example.com"]);
    // Cupo propio en el remitente: el aviso no compite con los mails de las personas.
    expect(h.enviar.mock.calls.map(([, opciones]) => opciones)).toEqual([{ tipo: "operador" }, { tipo: "operador" }]);
    for (const [mail] of h.enviar.mock.calls) {
      expect(mail.asunto).toBe(esAR["alta.avisoNumero.asunto"]);
      expect(mail.texto).toContain(esAR["alta.avisoNumero.motivo.sin_lugar"]);
      expect(mail.texto).toContain("/admin/altas");
      expect(`${mail.asunto}${mail.texto}`).not.toMatch(/\{motivo\}/);
      expect(JSON.stringify(mail)).not.toContain(TENANT);
    }
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each(MOTIVOS)("el motivo %s sale con su texto y sin el de otro motivo", async (motivo) => {
    await avisarNumeroEnRevision(motivo, TENANT);

    const [[mail]] = h.enviar.mock.calls;
    expect(mail.texto).toContain(esAR[`alta.avisoNumero.motivo.${motivo}`]);
    for (const otro of MOTIVOS.filter((m) => m !== motivo)) {
      expect(mail.texto).not.toContain(esAR[`alta.avisoNumero.motivo.${otro}`]);
    }
  });

  it("los textos del aviso existen en los dos idiomas y no se parecen", () => {
    const claves = [
      "alta.avisoNumero.asunto",
      "alta.avisoNumero.texto",
      "alta.avisoNumero.dosPasos",
      ...MOTIVOS.map((m) => `alta.avisoNumero.motivo.${m}` as const),
    ] as const;
    for (const clave of claves) {
      expect(esAR[clave], `es-AR le falta '${clave}'`).toBeTruthy();
      expect(enUS[clave], `en-US le falta '${clave}'`).toBeTruthy();
      expect(enUS[clave]).not.toBe(esAR[clave]);
    }
  });

  it("waba_huerfana vale para una WABA a medias que la base sí tiene (más de 48 h): el texto no afirma que la base no la tiene", () => {
    expect(esAR["alta.avisoNumero.motivo.waba_huerfana"]).toContain("48");
    expect(esAR["alta.avisoNumero.motivo.waba_huerfana"]).not.toContain("que la base no tiene");
    expect(enUS["alta.avisoNumero.motivo.waba_huerfana"]).toContain("48");
    expect(enUS["alta.avisoNumero.motivo.waba_huerfana"]).not.toContain("that the database does not have");
  });

  it("pais habla del código de país y de los +54 sin celular, no de un país solo", () => {
    const es = esAR["alta.avisoNumero.motivo.pais"];
    const en = enUS["alta.avisoNumero.motivo.pais"];
    expect(es).toContain("código de país");
    expect(es).toContain("+54");
    expect(es).not.toContain("móvil argentino");
    expect(es).not.toContain("no se mandó a Meta");
    expect(en).toContain("country code");
    expect(en).toContain("+54");
    expect(en).not.toContain("Argentine mobile");
    expect(en).not.toContain("not sent to Meta");
  });

  it("anota el espacio sólo en el registro, aunque no pueda mandar el mail", async () => {
    h.remitente.mockReturnValue(null);

    await avisarNumeroEnRevision("rechazo", TENANT);

    expect(h.warn).toHaveBeenCalledWith({ motivo: "rechazo", tenantId: TENANT }, "alta.numero_en_revision");
  });

  it("si hoy ya se avisó de ese motivo, no manda y devuelve el intento que el contador rechazó", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 60, ventana: VENTANA });

    await avisarNumeroEnRevision("sin_lugar", TENANT);

    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.liberarCupo).toHaveBeenCalledWith("alta:aviso-numero:sin_lugar", DIA_MS, VENTANA);
  });

  it("cada motivo tiene su cupo, igual para todos los espacios", async () => {
    await avisarNumeroEnRevision("sin_lugar", TENANT);
    await avisarNumeroEnRevision("sin_lugar", OTRO_TENANT);
    await avisarNumeroEnRevision("rechazo", TENANT);

    expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([
      "alta:aviso-numero:sin_lugar",
      "alta:aviso-numero:sin_lugar",
      "alta:aviso-numero:rechazo",
    ]);
  });

  it("cada número agregado a la WABA tiene su aviso: el cupo es del espacio", async () => {
    await avisarNumeroEnRevision("agregado", TENANT);
    await avisarNumeroEnRevision("agregado", OTRO_TENANT);

    expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([
      `alta:aviso-numero:agregado:${TENANT}`,
      `alta:aviso-numero:agregado:${OTRO_TENANT}`,
    ]);
    // El espacio está en la clave del contador, no en el mail.
    for (const [mail] of h.enviar.mock.calls) expect(JSON.stringify(mail)).not.toMatch(/1111|2222/);
  });

  it("un número que pudo haber entrado a la WABA (incierto) tiene su aviso: el cupo es del espacio", async () => {
    await avisarNumeroEnRevision("incierto", TENANT);
    await avisarNumeroEnRevision("incierto", OTRO_TENANT);

    expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([
      `alta:aviso-numero:incierto:${TENANT}`,
      `alta:aviso-numero:incierto:${OTRO_TENANT}`,
    ]);
    for (const [mail] of h.enviar.mock.calls) expect(JSON.stringify(mail)).not.toMatch(/1111|2222/);
  });

  it("un número que quedó sin su webhook (sin_webhook) tiene su aviso: el cupo es del espacio", async () => {
    await avisarNumeroEnRevision("sin_webhook", TENANT);
    await avisarNumeroEnRevision("sin_webhook", OTRO_TENANT);

    expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([
      `alta:aviso-numero:sin_webhook:${TENANT}`,
      `alta:aviso-numero:sin_webhook:${OTRO_TENANT}`,
    ]);
    for (const [mail] of h.enviar.mock.calls) expect(JSON.stringify(mail)).not.toMatch(/1111|2222/);
  });

  it.each(DE_LA_WABA_PROPIA_POR_ESPACIO)("%s (WABA propia): el cupo es del espacio y el espacio no sale en el mail", async (motivo) => {
    await avisarNumeroEnRevision(motivo, TENANT);
    await avisarNumeroEnRevision(motivo, OTRO_TENANT);

    expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([
      `alta:aviso-numero:${motivo}:${TENANT}`,
      `alta:aviso-numero:${motivo}:${OTRO_TENANT}`,
    ]);
    for (const [mail] of h.enviar.mock.calls) expect(JSON.stringify(mail)).not.toMatch(/1111|2222/);
  });

  describe("revocada de la app propia (R6)", () => {
    it("suma la línea de la verificación en dos pasos, a continuación del motivo", async () => {
      await avisarNumeroEnRevision("revocada", TENANT, { appPropia: true });

      expect(h.enviar).toHaveBeenCalledTimes(2);
      for (const [mail] of h.enviar.mock.calls) {
        expect(mail.texto).toContain(esAR["alta.avisoNumero.motivo.revocada"]);
        expect(mail.texto).toContain(esAR["alta.avisoNumero.dosPasos"]);
        expect(mail.texto.indexOf(esAR["alta.avisoNumero.dosPasos"])).toBeGreaterThan(mail.texto.indexOf(esAR["alta.avisoNumero.motivo.revocada"]));
        expect(`${mail.asunto}${mail.texto}`).not.toMatch(/\{motivo\}/);
      }
    });

    it("sin la opción, o con ella apagada, el mail es el de siempre", async () => {
      await avisarNumeroEnRevision("revocada", TENANT);
      await avisarNumeroEnRevision("revocada", TENANT, {});
      await avisarNumeroEnRevision("revocada", TENANT, { appPropia: false });

      expect(h.enviar).toHaveBeenCalledTimes(6);
      for (const [mail] of h.enviar.mock.calls) expect(mail.texto).not.toContain(esAR["alta.avisoNumero.dosPasos"]);
    });

    it.each(MOTIVOS.filter((m) => m !== "revocada"))("la opción no cambia el mail de %s: la línea es sólo de la revocación", async (motivo) => {
      await avisarNumeroEnRevision(motivo, TENANT, { appPropia: true });

      for (const [mail] of h.enviar.mock.calls) expect(mail.texto).not.toContain(esAR["alta.avisoNumero.dosPasos"]);
    });

    it("el cupo es el mismo con o sin la opción: es un aviso por espacio y día", async () => {
      await avisarNumeroEnRevision("revocada", TENANT, { appPropia: true });
      await avisarNumeroEnRevision("revocada", TENANT);

      expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([`alta:aviso-numero:revocada:${TENANT}`, `alta:aviso-numero:revocada:${TENANT}`]);
    });

    it("la línea no lleva datos de nadie, y avisa que el PIN lo generamos nosotros", () => {
      expect(esAR["alta.avisoNumero.dosPasos"]).toContain("PIN");
      expect(enUS["alta.avisoNumero.dosPasos"]).toContain("PIN");
      expect(esAR["alta.avisoNumero.dosPasos"]).not.toMatch(/\{[a-z]+\}/);
      expect(enUS["alta.avisoNumero.dosPasos"]).not.toMatch(/\{[a-z]+\}/);
    });
  });

  describe("lugares en la WABA (L5)", () => {
    it("agregado suma cuántos lugares quedan, a continuación del motivo", async () => {
      await avisarNumeroEnRevision("agregado", TENANT, { lugares: { usados: 2, tope: 3 } });

      expect(h.enviar).toHaveBeenCalledTimes(2);
      for (const [mail] of h.enviar.mock.calls) {
        expect(mail.texto).toContain("Quedan 1 de 3 lugares");
        expect(mail.texto.indexOf("Quedan 1 de 3")).toBeGreaterThan(mail.texto.indexOf(esAR["alta.avisoNumero.motivo.agregado"]));
        expect(mail.texto).not.toMatch(/\{(quedan|tope)\}/);
      }
    });

    it("sin la opción, el mail es el de siempre", async () => {
      await avisarNumeroEnRevision("agregado", TENANT);

      for (const [mail] of h.enviar.mock.calls) expect(mail.texto).not.toContain("lugares");
    });

    it.each(MOTIVOS.filter((m) => m !== "agregado"))("la opción no cambia el mail de %s: la línea es sólo del número agregado", async (motivo) => {
      await avisarNumeroEnRevision(motivo, TENANT, { lugares: { usados: 1, tope: 2 } });

      for (const [mail] of h.enviar.mock.calls) expect(mail.texto).not.toContain("Quedan 1 de 2");
    });

    it("con la WABA pasada del tope dice que no queda ninguno, no un número negativo", async () => {
      await avisarNumeroEnRevision("agregado", TENANT, { lugares: { usados: 5, tope: 3 } });

      for (const [mail] of h.enviar.mock.calls) expect(mail.texto).toContain("Quedan 0 de 3");
    });

    it("el cupo es el mismo con o sin la opción", async () => {
      await avisarNumeroEnRevision("agregado", TENANT, { lugares: { usados: 2, tope: 3 } });
      await avisarNumeroEnRevision("agregado", TENANT);

      expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([`alta:aviso-numero:agregado:${TENANT}`, `alta:aviso-numero:agregado:${TENANT}`]);
    });

    it("la línea existe en los dos idiomas, con los mismos huecos y el nombre de la variable", () => {
      for (const texto of [esAR["alta.avisoNumero.lugares"], enUS["alta.avisoNumero.lugares"]]) {
        expect(texto).toContain("{quedan}");
        expect(texto).toContain("{tope}");
        expect(texto).toContain("ALTA_NUMEROS_MAXIMOS_WABA");
      }
    });
  });

  it("cupo_semanal: un solo aviso por día para todos los espacios, porque el tope es de todos", async () => {
    await avisarNumeroEnRevision("cupo_semanal", TENANT);
    await avisarNumeroEnRevision("cupo_semanal", OTRO_TENANT);

    expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual(["alta:aviso-numero:cupo_semanal", "alta:aviso-numero:cupo_semanal"]);
  });

  it.each(["sin_fila", "sin_credencial", "de_otro_ambiente", "pais"] as const)("%s: un solo aviso por día para todos los espacios", async (motivo) => {
    await avisarNumeroEnRevision(motivo, TENANT);
    await avisarNumeroEnRevision(motivo, OTRO_TENANT);

    expect(h.rateLimit.mock.calls.map(([clave]) => clave)).toEqual([`alta:aviso-numero:${motivo}`, `alta:aviso-numero:${motivo}`]);
  });

  it("sin remitente del sistema no toma el cupo", async () => {
    h.remitente.mockReturnValue(null);

    await avisarNumeroEnRevision("sin_lugar", TENANT);

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("sin direcciones de operación no toma el cupo", async () => {
    h.operadores.mockReturnValue([]);

    await avisarNumeroEnRevision("sin_lugar", TENANT);

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("si no salió ninguno, devuelve el cupo para que el próximo pedido del día pueda avisar", async () => {
    h.enviar.mockResolvedValue({ enviado: false, motivo: "tope" });

    await avisarNumeroEnRevision("sin_dueno", TENANT);

    expect(h.liberarCupo).toHaveBeenCalledWith("alta:aviso-numero:sin_dueno", DIA_MS, VENTANA);
  });

  it("si salió a alguno, el cupo queda gastado", async () => {
    h.enviar.mockResolvedValueOnce({ enviado: false, motivo: "tope" }).mockResolvedValueOnce({ enviado: true });

    await avisarNumeroEnRevision("sin_dueno", TENANT);

    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("nunca lanza: una falla se anota, sin el mensaje ni el espacio", async () => {
    h.rateLimit.mockRejectedValue(new Error(`sin base para ${TENANT}`));

    await expect(avisarNumeroEnRevision("sin_lugar", TENANT)).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.aviso_numero_fallo");
  });

  it("nunca lanza si el envío tira", async () => {
    h.enviar.mockRejectedValue(new Error("sin red"));

    await expect(avisarNumeroEnRevision("pais", TENANT)).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.aviso_numero_fallo");
  });
});
