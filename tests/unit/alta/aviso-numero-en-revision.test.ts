/**
 * El aviso de que un número del alta automática se mira a mano.
 *
 * Una vez por día y motivo (cada número agregado a la WABA, o que pudo haber
 * entrado, el suyo), a cada
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
vi.mock("@/lib/auth/require-operator", () => ({ operatorEmails: h.operadores }));
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
];

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
      ...MOTIVOS.map((m) => `alta.avisoNumero.motivo.${m}` as const),
    ] as const;
    for (const clave of claves) {
      expect(esAR[clave], `es-AR le falta '${clave}'`).toBeTruthy();
      expect(enUS[clave], `en-US le falta '${clave}'`).toBeTruthy();
      expect(enUS[clave]).not.toBe(esAR[clave]);
    }
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

  it.each(["sin_fila", "sin_credencial"] as const)("%s: un solo aviso por día para todos los espacios", async (motivo) => {
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
