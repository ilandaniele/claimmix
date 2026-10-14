/**
 * Las pantallas del asistente de «app propia», una por paso: P0 (antes de empezar), P1 (crear la app y
 * pegar sus claves), P1B (completar sus datos), E14 (conectar los avisos), P2 (sumar el número), P3 (usuario
 * del sistema y token), P4 (probar), G (conectado) y «seguir» (una conexión a medias).
 *
 * Cada una pinta lo que le toca y le pide al panel (`ControlDelPanel`) que hable con el servidor. Los
 * textos salen del diccionario; los nombres de los botones y los menús de Meta van entre «» tal como los
 * muestra Meta, en inglés mientras no estén las capturas de su panel en español.
 */

"use client";

import { useEffect, useId, useRef, useState } from "react";

import { estadoDelNombre } from "@/app/conectar-whatsapp/vista";
import { enUS } from "@/lib/i18n/en-US";
import { useT } from "@/lib/i18n/LocaleContext";
import type { CategoriaDePerfil } from "@/lib/whatsapp-categorias";
import type { EstadoDeApp, LegalesDeApp } from "@/server/alta/app-propia";
import { VERSION_DEL_ANEXO } from "@/server/alta/waba-resultados";

import { estadoDeAppPropia, iniciarAppPropia, credencialesDeAppPropia, reintentarWabaPropia, webhookDeAppPropia } from "../actions";
import { BOTON, BOTON_SUAVE, ENLACE, SIGUE_EN, SelectorDeCategoria, WHATSAPP_MANAGER } from "../WabaPropiaPanel";
import {
  AvisoDeResultado,
  Banner,
  Bloque,
  CampoDeTexto,
  CampoSecreto,
  Copiable,
  Encabezado,
  EnlaceMeta,
  Guia,
  Lista,
  META_APPS,
  META_GUIA,
  META_GUIA_NUMEROS,
  META_GUIA_USUARIO,
  META_GUIA_WEBHOOK,
  META_USUARIOS,
  Parrafo,
  Pie,
  useSondeo,
  type ControlDelPanel,
} from "./piezas";
import { claveDeLaFalla, lugarDelAvisoDeToken, rellenar, sigueEnElServidor, ventanaDeFalla } from "./vista";

const ICONO = "/conectar-whatsapp/app/icono";
const ANEXO = "/terms#app-propia";
const MINUTO_MS = 60_000;

/** Un CUIT tiene 11 números, con o sin guiones; el dígito verificador lo mira el servidor. */
const cuitCompleto = (cuit: string) => cuit.replace(/\D/g, "").length === 11;

/** Un enlace de texto que sale de ClaimMix: pestaña nueva, sin pasarle a la otra página de dónde viene. */
function EnlaceDeTexto({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={ENLACE}>
      {children}
    </a>
  );
}

/* ── P0: antes de empezar ─────────────────────────────────────────────────── */

export function PasoInicial({ control, numeroTipeado }: { control: ControlDelPanel; numeroTipeado: string | null }) {
  const t = useT();
  const [razon, setRazon] = useState("");
  const [cuit, setCuit] = useState("");
  const [acuerdo, setAcuerdo] = useState(false);
  const [cambiando, setCambiando] = useState(numeroTipeado === null);
  const [numero, setNumero] = useState("");
  const idAcuerdo = useId();
  const puede = acuerdo && razon.trim() !== "" && cuitCompleto(cuit) && !control.ocupado;

  function empezar() {
    if (!puede) return;
    void control.correr(() =>
      iniciarAppPropia({ acuerdo: VERSION_DEL_ANEXO, razonSocial: razon.trim(), cuit: cuit.trim(), numero: cambiando ? numero.trim() : undefined })
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        empezar();
      }}
    >
      <Encabezado pantalla="P0" titulo={t("appPropia.antes.titulo")} />
      <Parrafo>{t("appPropia.descripcion")}</Parrafo>
      <Parrafo>{t("appPropia.antes.intro")}</Parrafo>
      <Bloque titulo={t("appPropia.antes.necesitas")}>
        <Lista
          numerada={false}
          items={[t("appPropia.antes.necesitasAdmin"), t("appPropia.antes.necesitasCelular"), t("appPropia.antes.necesitasTarjeta")]}
        />
      </Bloque>
      <Bloque titulo={t("appPropia.antes.numeroTitulo")}>
        <Lista numerada={false} items={[t("appPropia.antes.numeroNuevo"), t("appPropia.antes.numeroActual")]} />
        {cambiando ? (
          <CampoDeTexto
            etiqueta={t("appPropia.antes.numeroCampo")}
            valor={numero}
            alCambiar={setNumero}
            maxLength={20}
            inputMode="tel"
            autoComplete="tel"
          />
        ) : (
          <p className="mt-3 flex flex-wrap items-center gap-x-3 text-sm text-slate-700">
            <span>{t("appPropia.antes.numero").replace("{numero}", numeroTipeado ?? "-")}</span>
            <button type="button" className={ENLACE} onClick={() => setCambiando(true)}>
              {t("appPropia.antes.cambiarNumero")}
            </button>
          </p>
        )}
      </Bloque>
      <Parrafo>{t("appPropia.antes.legalesAyuda")}</Parrafo>
      <CampoDeTexto
        etiqueta={t("appPropia.antes.razonSocial")}
        valor={razon}
        alCambiar={setRazon}
        maxLength={120}
        autoComplete="organization"
      />
      <CampoDeTexto etiqueta={t("appPropia.antes.cuit")} valor={cuit} alCambiar={setCuit} maxLength={13} inputMode="numeric" />
      <label htmlFor={idAcuerdo} className="mt-4 flex items-start gap-2 text-sm font-medium text-slate-800">
        <input
          id={idAcuerdo}
          type="checkbox"
          checked={acuerdo}
          onChange={(e) => setAcuerdo(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
        />
        {t("appPropia.antes.acuerdo")}
      </label>
      <p className="ml-6 mt-1">
        <EnlaceDeTexto href={ANEXO}>{t("appPropia.antes.verAnexo")}</EnlaceDeTexto>
      </p>
      <AvisoDeResultado aviso={control.aviso} />
      <button type="submit" disabled={!puede} className={`${BOTON} mt-5`}>
        {control.ocupado ? t("waba.cargando") : t("appPropia.antes.empezar")}
      </button>
      <Pie control={control} />
    </form>
  );
}

/* ── P1: crear la app y pegar sus claves ──────────────────────────────────── */

export function PasoApp({ control, empresa }: { control: ControlDelPanel; empresa: string }) {
  const t = useT();
  const [appId, setAppId] = useState("");
  const [secreto, setSecreto] = useState("");
  const puede = appId.trim() !== "" && secreto.trim() !== "" && !control.ocupado;

  async function validar() {
    if (!puede) return;
    const r = await control.correr(() => credencialesDeAppPropia({ appId: appId.trim(), secreto: secreto.trim() }));
    if (sigueEnElServidor(r)) setSecreto("");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void validar();
      }}
    >
      <Encabezado pantalla="P1" titulo={t("appPropia.app.titulo")} />
      <Bloque titulo={t("appPropia.app.crear")}>
        <Lista
          items={[
            t("appPropia.app.p1"),
            t("appPropia.app.p2"),
            t("appPropia.app.p3"),
            t("appPropia.app.p4"),
            rellenar(t("appPropia.app.p5"), { empresa: empresa.trim() }),
          ]}
        />
        <EnlaceMeta href={META_APPS}>{t("appPropia.abrirMeta")}</EnlaceMeta>
        <Guia href={META_GUIA} />
      </Bloque>
      <Bloque titulo={t("appPropia.claves.pegar")}>
        <Lista items={[t("appPropia.claves.p1"), t("appPropia.claves.p2"), t("appPropia.claves.p3")]} />
        <CampoDeTexto
          etiqueta={t("appPropia.claves.campoApp")}
          valor={appId}
          alCambiar={setAppId}
          maxLength={20}
          inputMode="numeric"
          invalido={control.aviso?.resultado === "formato_app"}
        />
        <CampoSecreto
          etiqueta={t("appPropia.claves.campoSecreto")}
          valor={secreto}
          alCambiar={setSecreto}
          maxLength={128}
          invalido={control.aviso?.resultado === "formato_secreto"}
        />
        <Parrafo>{t("appPropia.claves.aviso")}</Parrafo>
      </Bloque>
      <AvisoDeResultado aviso={control.aviso} appId={appId.trim()} />
      <button type="submit" disabled={!puede} className={`${BOTON} mt-5`}>
        {control.ocupado ? t("appPropia.validando") : t("appPropia.validar")}
      </button>
      <Pie control={control} />
    </form>
  );
}

/* ── P1B: completar los datos de la app ───────────────────────────────────── */

export function PasoDatos({ control, legales, avanzar }: { control: ControlDelPanel; legales: LegalesDeApp | undefined; avanzar: () => void }) {
  const t = useT();
  return (
    <div>
      <Encabezado pantalla="P1B" titulo={t("appPropia.completar.titulo")} />
      <Parrafo>{t("appPropia.completar.p1")}</Parrafo>
      <Lista
        items={[
          <>
            {t("appPropia.completar.icono")}
            <a href={ICONO} download className={`${BOTON_SUAVE} mt-2 block`}>
              {t("appPropia.completar.descargarIcono")}
            </a>
          </>,
          t("appPropia.completar.categoria"),
          t("appPropia.completar.proposito"),
          <>
            {t("appPropia.completar.borrado")}
            {legales?.borrado && <Copiable etiqueta="Data deletion instructions URL" valor={legales.borrado} />}
          </>,
          legales?.listos ? (
            t("appPropia.completar.legalesListos")
          ) : (
            <>
              {t("appPropia.completar.legalesCopiar")}
              {legales?.terminos && <Copiable etiqueta="Terms of Service URL" valor={legales.terminos} />}
              {legales?.privacidad && <Copiable etiqueta="Privacy Policy URL" valor={legales.privacidad} />}
              {legales?.contacto && <Copiable etiqueta="Contact email" valor={legales.contacto} />}
              <span className="mt-2 block">{t("appPropia.completar.legalesPropios")}</span>
            </>
          ),
          t("appPropia.completar.guardar"),
        ]}
      />
      <EnlaceMeta href={META_APPS}>{t("appPropia.abrirMeta")}</EnlaceMeta>
      <button type="button" className={`${BOTON} mt-5`} onClick={avanzar}>
        {t("appPropia.seguir")}
      </button>
      <Pie control={control} />
    </div>
  );
}

/* ── E14: conectar los avisos de la app ───────────────────────────────────── */

type DatosDeAvisos = { url: string; verifyToken: string; aviso: "ajeno" | "revisar" | null };

/**
 * Los dos datos para el webhook y la espera de que Meta llame. Consulta cada 3 segundos durante un minuto;
 * `alVerificar` se llama una sola vez, cuando el servidor ya vio la verificación. Con `reanudar` la
 * verificación ya estaba hecha y el callback de la app cambió después (apunta a otro lado): no hay nada que
 * esperar, la persona lo corrige en Meta y sigue a mano.
 */
export function PasoWebhook({
  control,
  webhook,
  alVerificar,
  reanudar,
}: {
  control: ControlDelPanel;
  webhook: { url: string; verifyToken: string } | undefined;
  alVerificar: () => void;
  reanudar?: () => void;
}) {
  const t = useT();
  const [datos, setDatos] = useState<DatosDeAvisos | null>(webhook ? { ...webhook, aviso: null } : null);
  const [verificado, setVerificado] = useState(false);
  const avisado = useRef(false);

  useEffect(() => {
    let vigente = true;
    // Al abrir, el servidor mira el callback que la app ya tiene y deja el nuestro si puede.
    webhookDeAppPropia()
      .then((r) => {
        if (vigente && r.webhook) setDatos(r.webhook);
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, []);

  const sondeo = useSondeo(
    async () => {
      const r = await estadoDeAppPropia();
      if (!("paso" in r) || !r.webhookVerificado || avisado.current) return;
      avisado.current = true;
      setVerificado(true);
      alVerificar();
    },
    3_000,
    MINUTO_MS,
    !verificado && !reanudar
  );

  return (
    <div>
      <Encabezado pantalla="E14" titulo={t("appPropia.webhook.titulo")} />
      <Lista
        items={[
          t("appPropia.webhook.p1"),
          <>
            {t("appPropia.webhook.p2")}
            {datos && (
              <>
                <Copiable etiqueta={t("appPropia.webhook.url")} valor={datos.url} />
                <Copiable etiqueta={t("appPropia.webhook.token")} valor={datos.verifyToken} />
              </>
            )}
          </>,
          t("appPropia.webhook.p3"),
          t("appPropia.webhook.p4"),
        ]}
      />
      <EnlaceMeta href={META_APPS}>{t("appPropia.abrirMeta")}</EnlaceMeta>
      <Guia href={META_GUIA_WEBHOOK} />
      {datos?.aviso && <Banner>{t(datos.aviso === "ajeno" ? "appPropia.webhook.ajeno" : "appPropia.webhook.revisar")}</Banner>}
      {reanudar ? (
        <button type="button" className={`${BOTON} mt-5`} disabled={control.ocupado} onClick={reanudar}>
          {t("appPropia.seguir")}
        </button>
      ) : verificado ? (
        <Banner tono="ok" rol="status">
          {t("appPropia.webhook.verificado")}
        </Banner>
      ) : sondeo.agotado ? (
        <>
          <Banner>{t("appPropia.r.webhook_demora")}</Banner>
          <button type="button" className={`${BOTON_SUAVE} mt-3`} onClick={sondeo.reiniciar}>
            {t("appPropia.webhook.esperarMas")}
          </button>
        </>
      ) : (
        <p role="status" className="mt-4 text-sm text-slate-600">
          {t("appPropia.webhook.esperando")}
        </p>
      )}
      <AvisoDeResultado aviso={control.aviso} />
      <Pie control={control} />
    </div>
  );
}

/* ── P2: sumar el número ──────────────────────────────────────────────────── */

export function PasoCuenta({
  control,
  numero,
  categoria,
  alCambiarCategoria,
  avanzar,
}: {
  control: ControlDelPanel;
  numero: string | null;
  categoria: CategoriaDePerfil;
  alCambiarCategoria: (categoria: CategoriaDePerfil) => void;
  avanzar: () => void;
}) {
  const t = useT();

  return (
    <div>
      <Encabezado pantalla="P2" titulo={t("appPropia.cuenta.titulo")} />
      <Lista
        items={[
          t("appPropia.cuenta.p1"),
          t("appPropia.cuenta.prueba"),
          rellenar(t("appPropia.cuenta.p2"), { numero: numero ?? "-" }),
          t("appPropia.cuenta.nombre"),
          // El formulario de Meta está en inglés: se nombra la opción como la verá, junto a la del idioma de la persona.
          rellenar(t("appPropia.cuenta.categoria"), {
            categoria: t(`waba.categoria.${categoria}`),
            enMeta: enUS[`waba.categoria.${categoria}`],
          }),
          t("appPropia.cuenta.yaEnWhatsapp"),
          t("appPropia.cuenta.tope"),
        ]}
      />
      <SelectorDeCategoria valor={categoria} alCambiar={alCambiarCategoria} ayuda="appPropia.cuenta.categoriaAyuda" className="mt-4" />
      <EnlaceMeta href={META_APPS}>{t("appPropia.abrirMeta")}</EnlaceMeta>
      <Guia href={META_GUIA_NUMEROS} />
      <button type="button" className={`${BOTON} mt-5`} onClick={avanzar}>
        {t("appPropia.seguir")}
      </button>
      <Pie control={control} />
    </div>
  );
}

/* ── P3: usuario del sistema y token ──────────────────────────────────────── */

export function PasoUsuario({
  control,
  appId,
  token,
  wabaId,
  alCambiarToken,
  alCambiarWaba,
  validar,
}: {
  control: ControlDelPanel;
  appId: string | null;
  token: string;
  wabaId: string;
  alCambiarToken: (valor: string) => void;
  alCambiarWaba: (valor: string) => void;
  validar: () => void;
}) {
  const t = useT();
  const puede = token.trim() !== "" && wabaId.trim() !== "" && !control.ocupado;
  const aviso = control.aviso;
  const lugar = aviso ? lugarDelAvisoDeToken(aviso.resultado) : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (puede) validar();
      }}
    >
      <Encabezado pantalla="P3" titulo={t("appPropia.usuario.titulo")} />
      <Parrafo>{t("appPropia.usuario.portfolio")}</Parrafo>
      <Bloque titulo={t("appPropia.usuario.bloque1")}>
        <Lista items={[t("appPropia.usuario.p1"), t("appPropia.usuario.p2")]} />
        <EnlaceMeta href={META_USUARIOS}>{t("appPropia.abrirMeta")}</EnlaceMeta>
        <Guia href={META_GUIA_USUARIO} />
      </Bloque>
      <Bloque titulo={t("appPropia.usuario.bloque2")}>
        <Lista items={[t("appPropia.usuario.p3")]} />
        <Parrafo>{t("appPropia.usuario.noPrueba")}</Parrafo>
        <Parrafo>{t("appPropia.usuario.demora")}</Parrafo>
        {lugar === "bloque2" && <AvisoDeResultado aviso={aviso} appId={appId} />}
      </Bloque>
      <Bloque titulo={t("appPropia.token.bloque3")}>
        <Lista items={[t("appPropia.token.p1"), t("appPropia.token.p2"), t("appPropia.token.p3"), t("appPropia.token.p4")]} />
        <CampoSecreto etiqueta={t("appPropia.token.campo")} valor={token} alCambiar={alCambiarToken} maxLength={2048} invalido={lugar === "bloque3"} />
        {lugar === "bloque3" && <AvisoDeResultado aviso={aviso} appId={appId} />}
        <CampoDeTexto
          etiqueta={t("appPropia.token.wabaCampo")}
          valor={wabaId}
          alCambiar={alCambiarWaba}
          maxLength={20}
          inputMode="numeric"
          invalido={lugar === "waba"}
          ayuda={t("appPropia.token.wabaAyuda")}
        />
        {lugar === "waba" && <AvisoDeResultado aviso={aviso} appId={appId} />}
      </Bloque>
      <button type="submit" disabled={!puede} className={`${BOTON} mt-5`}>
        {control.ocupado ? t("appPropia.validando") : t("appPropia.validar")}
      </button>
      <Pie control={control} />
    </form>
  );
}

/* ── P4: probar ───────────────────────────────────────────────────────────── */

const DOS_MINUTOS_MS = 2 * MINUTO_MS;
const DIEZ_MINUTOS_MS = 10 * MINUTO_MS;

export function PasoPrueba({ control, estado }: { control: ControlDelPanel; estado: EstadoDeApp | null }) {
  const t = useT();
  const [vivo, setVivo] = useState(estado);
  const pagoAvisado = useRef(false);
  const listo = vivo?.primeraRespuesta === true;
  const llego = vivo?.primerMensaje === true;
  const numero = vivo?.numero ?? "-";

  const sondeo = useSondeo(
    async () => {
      const r = await estadoDeAppPropia();
      if (!("paso" in r)) return;
      setVivo(r);
      // Un rechazo por pago en la primera respuesta se cuenta una vez, sin cortar la espera.
      if (r.estado === "falla" && r.falla === "pago_pendiente" && !pagoAvisado.current) {
        pagoAvisado.current = true;
        control.abrir({ tipo: "E8" });
      }
    },
    5_000,
    DIEZ_MINUTOS_MS,
    !listo
  );
  const pasaron2 = sondeo.transcurrido >= DOS_MINUTOS_MS;

  return (
    <div>
      <Encabezado pantalla="P4" titulo={t("appPropia.final.titulo")} />
      <Parrafo>{t("appPropia.final.intro")}</Parrafo>
      <Lista
        numerada={false}
        items={[
          t("appPropia.final.live"),
          <>
            {t("appPropia.final.pago")}{" "}
            <EnlaceDeTexto href={WHATSAPP_MANAGER}>{t("waba.estado.pagoEnlace")}</EnlaceDeTexto>
          </>,
        ]}
      />
      <p className="mt-5 text-sm font-medium text-slate-900">{rellenar(t("appPropia.prueba.texto"), { numero })}</p>
      {listo ? (
        <>
          <Banner tono="ok" rol="status">
            {t("appPropia.prueba.listo")}
          </Banner>
          <a href={SIGUE_EN} className={`${BOTON} mt-4 block`}>
            {t("appPropia.seguir")}
          </a>
        </>
      ) : (
        <>
          <p role="status" className="mt-3 text-sm text-slate-600">
            {llego ? t("appPropia.prueba.esperandoRespuesta") : t("appPropia.prueba.esperandoMensaje")}
          </p>
          {pasaron2 && !llego && (
            <>
              <Banner>{t("appPropia.prueba.sinMensaje")}</Banner>
              <Lista
                numerada={false}
                items={[
                  t("appPropia.prueba.live"),
                  t("appPropia.prueba.conectado"),
                  rellenar(t("appPropia.prueba.destino"), { numero }),
                  t("appPropia.prueba.campos"),
                ]}
              />
            </>
          )}
          {pasaron2 && llego && (
            <Banner>
              {t("appPropia.prueba.sinRespuesta")}{" "}
              <EnlaceDeTexto href={WHATSAPP_MANAGER}>{t("waba.estado.pagoEnlace")}</EnlaceDeTexto>
            </Banner>
          )}
          {sondeo.agotado && (
            <>
              <Banner>{t("appPropia.prueba.demora")}</Banner>
              <button type="button" className={`${BOTON_SUAVE} mt-3`} onClick={sondeo.reiniciar}>
                {t("appPropia.prueba.otraVez")}
              </button>
            </>
          )}
        </>
      )}
      <Pie control={control} />
    </div>
  );
}

/* ── G: conectado ─────────────────────────────────────────────────────────── */

const ENVIO = { AVAILABLE: "appPropia.estado.envio.AVAILABLE", LIMITED: "appPropia.estado.envio.LIMITED", BLOCKED: "appPropia.estado.envio.BLOCKED" } as const;

export function PasoGestion({ control, estado }: { control: ControlDelPanel; estado: EstadoDeApp | null }) {
  const t = useT();
  const falla = estado?.estado === "falla" ? (estado.falla ?? "") : null;
  const ventanaDeLaFalla = falla !== null ? ventanaDeFalla(falla) : null;
  const nombre = estadoDelNombre(estado?.nombreEstado ?? null);
  const envio = estado?.puedeEnviar && Object.hasOwn(ENVIO, estado.puedeEnviar) ? ENVIO[estado.puedeEnviar as keyof typeof ENVIO] : null;

  return (
    <div>
      <Encabezado pantalla="G" titulo={t("appPropia.estado.titulo")} />
      {falla === null ? (
        <p role="status" className="text-sm text-slate-700">
          {t("waba.conectado.texto").replace("{numero}", estado?.numero ?? "-")}
        </p>
      ) : (
        <>
          <Banner>{rellenar(t(claveDeLaFalla(falla)), { appId: estado?.appId ?? "" })}</Banner>
          <button
            type="button"
            disabled={control.ocupado}
            className={`${BOTON} mt-3`}
            onClick={() => (ventanaDeLaFalla ? control.abrir(ventanaDeLaFalla) : void control.correr(reintentarWabaPropia))}
          >
            {control.ocupado ? t("waba.cargando") : t(ventanaDeLaFalla ? "waba.seguirDonde" : "waba.reintentar")}
          </button>
        </>
      )}
      <AvisoDeResultado aviso={control.aviso} appId={estado?.appId} />
      <ul className="mb-5 mt-4 list-disc space-y-2 pl-5 text-sm text-slate-600">
        {estado?.appId && <li>{rellenar(t("appPropia.estado.app"), { appId: estado.appId })}</li>}
        <li>
          {t("appPropia.estado.mensajes")}: {t(estado?.primerMensaje ? "appPropia.estado.mensajesOk" : "appPropia.estado.mensajesPendiente")}
        </li>
        {envio && (
          <li>
            {t("appPropia.estado.envio")}: {t(envio)}
          </li>
        )}
        <li>{t(`waba.estado.nombre.${nombre ?? "sin"}`)}</li>
        <li>{t(estado?.plantilla ? "waba.estado.plantilla.enviada" : "waba.estado.plantilla.pendiente")}</li>
        <li>
          {t("waba.estado.pago")} <EnlaceDeTexto href={WHATSAPP_MANAGER}>{t("waba.estado.pagoEnlace")}</EnlaceDeTexto>
        </li>
      </ul>
      <a href={SIGUE_EN} className={`${BOTON} block`}>
        {t("waba.seguir")}
      </a>
      <button type="button" className={`${BOTON_SUAVE} mt-3`} onClick={() => control.abrir({ tipo: "E7" })}>
        {t("appPropia.estado.actualizarSecreto")}
      </button>
      {nombre === "otro" && ventanaDeLaFalla?.tipo !== "E10" && (
        <button type="button" className={`${BOTON_SUAVE} mt-3`} onClick={() => control.abrir({ tipo: "E10" })}>
          {t("appPropia.nombre.cambiar")}
        </button>
      )}
      <button type="button" className={`${BOTON_SUAVE} mt-3`} onClick={control.pedirBaja}>
        {t("waba.desconectar.boton")}
      </button>
      <p className="mt-5 text-xs text-slate-500">{t("appPropia.estado.responsable")}</p>
      {control.ayuda && (
        <p className="mt-4 text-center">
          <a href={control.ayuda} className={ENLACE}>
            {t("waba.ayuda")}
          </a>
        </p>
      )}
    </div>
  );
}

/* ── seguir: una conexión a medias ────────────────────────────────────────── */

export function PasoSeguir({ control, alSeguir }: { control: ControlDelPanel; alSeguir: () => void }) {
  const t = useT();
  return (
    <div>
      <p role="status" className="text-sm text-slate-600">
        {t("appPropia.reanudar.texto")}
      </p>
      <AvisoDeResultado aviso={control.aviso} />
      <button type="button" disabled={control.ocupado} className={`${BOTON} mt-4`} onClick={alSeguir}>
        {control.ocupado ? t("waba.cargando") : t("appPropia.seguir")}
      </button>
      <Pie control={control} />
    </div>
  );
}
