/**
 * El panel de /conectar-whatsapp: la lista de antes de empezar, el popup de Meta y lo
 * que sigue (número distinto, código, PIN, cancelaciones) hasta «conectado».
 *
 * Qué pantalla toca lo deciden `vista.ts` (puro) y las acciones del servidor, que
 * contestan con una lista cerrada: acá no se muestra ningún texto que no sea del
 * diccionario. Lo que cuenta el popup (ids, evento) viaja como pista y lo resuelve el
 * servidor; `meta-sdk.ts` se ocupa del SDK y de leer el `postMessage` sin fiarse.
 *
 * El SDK se carga al terminar la lista, no al tocar el botón de Meta, y ese último
 * clic llama a `FB.login` sin esperar nada: un navegador sólo deja abrir el popup
 * dentro del gesto de la persona.
 *
 * Esta ruta vive fuera de `(app)` y no tiene `LocaleProvider`, así que lo trae acá.
 */

"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useDialogoModal } from "@/app/(app)/_components/dialogo-modal";
import type { ClaveDePagina, Locale } from "@/lib/i18n";
import { LocaleProvider, useLocale, useT } from "@/lib/i18n/LocaleContext";
import { CATEGORIA_INICIAL, CATEGORIAS_DE_PERFIL, categoriaDePerfil, type CategoriaDePerfil } from "@/lib/whatsapp-categorias";
import type { ResultadoDeApp } from "@/server/alta/waba-resultados";

import {
  aceptarNumeroDeMeta,
  cancelacionDeWabaPropia,
  codigoDeWabaPropia,
  conectarWabaPropia,
  desconectarWabaPropia,
  iniciarWabaPropia,
  pinDeWabaPropia,
  reintentarWabaPropia,
  type Vinculo,
} from "./actions";
import { abrirRegistro, cargarSdk, type SalidaDelPopup, type SdkDeFacebook } from "./meta-sdk";
import { despuesDe, reintentoDe, type EstadoDeVista, type Aviso } from "./vista";

/**
 * Adónde sigue quien conectó o quiere seguir por mail: los primeros pasos, que ya sabe qué falta.
 * Se llega con `<a>` y no con `<Link>`: salir de esta ruta pide una carga completa, porque la
 * CSP del SDK de Meta es de esta ruta y una navegación del cliente no la cambia.
 */
export const SIGUE_EN = "/configuracion?primeros=1";
export const WHATSAPP_MANAGER = "https://business.facebook.com/wa/manage/home/";
/** El sello del inicio vale 10 minutos: pasados estos, abrir el popup otra vez pide uno nuevo. */
const FRESCURA_DEL_INICIO_MS = 8 * 60_000;
/** El código del SMS y el PIN del segundo factor son de seis dígitos; el servidor lo vuelve a mirar. */
export const DE_SEIS = /^\d{6}$/;

export const BOTON =
  "w-full rounded-full bg-violet-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-60";
export const BOTON_SUAVE =
  "w-full rounded-full border border-slate-300 bg-white px-4 py-2.5 text-center text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-60";
export const ENLACE =
  "rounded text-sm font-medium text-slate-700 underline underline-offset-4 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";
export const CAMPO =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-500";

/**
 * El rubro del perfil de WhatsApp, que elige el cliente en las dos vías (sólo viene preseleccionado el inicial).
 * Lo comparten este panel y el asistente de la app propia. Ordenado por la etiqueta del idioma: el orden de la
 * lista de Meta es el de sus códigos.
 */
export function SelectorDeCategoria({
  valor,
  alCambiar,
  ayuda,
  className,
}: {
  valor: CategoriaDePerfil;
  alCambiar: (categoria: CategoriaDePerfil) => void;
  /** La clave del texto que explica para qué sirve el rubro en la vía donde se usa. */
  ayuda: ClaveDePagina;
  className?: string;
}) {
  const t = useT();
  const { locale } = useLocale();
  const idCampo = useId();
  const idAyuda = useId();
  const categorias = useMemo(
    () =>
      CATEGORIAS_DE_PERFIL.map((v) => ({ valor: v, etiqueta: t(`waba.categoria.${v}`) })).sort((a, b) =>
        a.etiqueta.localeCompare(b.etiqueta, locale)
      ),
    [t, locale]
  );

  return (
    <div className={className}>
      <label htmlFor={idCampo} className="mb-1.5 block text-sm font-medium text-slate-700">
        {t("waba.antes.categoria")}
      </label>
      <select
        id={idCampo}
        value={valor}
        aria-describedby={idAyuda}
        onChange={(e) => alCambiar(categoriaDePerfil(e.target.value) ?? valor)}
        className={CAMPO}
      >
        {categorias.map((c) => (
          <option key={c.valor} value={c.valor}>
            {c.etiqueta}
          </option>
        ))}
      </select>
      <p id={idAyuda} className="mt-1.5 text-xs text-slate-500">
        {t(ayuda)}
      </p>
    </div>
  );
}

export interface DatosDelConectado {
  numero: string | null;
  nombre: "aprobado" | "revision" | "otro" | null;
  plantilla: boolean;
}

export interface WabaPropiaPanelProps {
  locale: Locale;
  textos: Record<ClaveDePagina, string>;
  /** El nombre del espacio: precarga el nombre visible del número. */
  nombre: string;
  /** El número que la persona escribió al registrarse. */
  numeroTipeado: string | null;
  inicial: EstadoDeVista;
  conectado: DatosDelConectado;
  /** `mailto:` a quien atiende los avisos del alta; null si no hay dirección. */
  ayuda: string | null;
}

export function WabaPropiaPanel(props: WabaPropiaPanelProps) {
  return (
    <LocaleProvider locale={props.locale} textos={props.textos}>
      <Panel {...props} />
    </LocaleProvider>
  );
}

interface Apertura {
  inicio: string;
  configId: string;
  setup: object | undefined;
  en: number;
}

function Panel({ locale, nombre: nombreDelEspacio, numeroTipeado, inicial, conectado, ayuda }: WabaPropiaPanelProps) {
  const t = useT();
  const router = useRouter();
  const [estado, setEstado] = useState<EstadoDeVista>(inicial);
  const [abierto, setAbierto] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [confirmandoBaja, setConfirmandoBaja] = useState(false);
  const [listaCompleta, setListaCompleta] = useState(false);
  const [nombre, setNombre] = useState(nombreDelEspacio.slice(0, 60));
  const [web, setWeb] = useState("");
  const [categoria, setCategoria] = useState(CATEGORIA_INICIAL);
  const sdk = useRef<SdkDeFacebook | null>(null);
  const apertura = useRef<Apertura | null>(null);
  const cancelarBaja = useRef<HTMLButtonElement>(null);

  const idNombre = useId();
  const idWeb = useId();
  const idWebAyuda = useId();

  /**
   * Pasa a la vista que sigue al resultado de una acción. Conectar o desconectar cambia lo que lee
   * la página, así que se refresca, salvo que la acción ya lo haya hecho (`yaRefresca`).
   */
  function avanzar(resultado: ResultadoDeApp, numeroMeta?: string, yaRefresca = false) {
    setEstado((antes) => despuesDe(resultado, antes, numeroMeta));
    setAbierto(true);
    if (!yaRefresca && (resultado === "conectado" || resultado === "desconectado")) router.refresh();
  }

  async function correr(accion: () => Promise<Vinculo>, yaRefresca = false) {
    setOcupado(true);
    try {
      const r = await accion();
      avanzar(r.resultado, r.numeroMeta, yaRefresca);
    } catch {
      avanzar("meta");
    } finally {
      setOcupado(false);
    }
  }

  /** El paso que sigue a la lista: pide el inicio al servidor y carga el SDK, pero todavía no abre nada. */
  async function preparar() {
    setOcupado(true);
    try {
      const r = await iniciarWabaPropia({ nombre: nombre.trim(), web: web.trim() || undefined, categoria });
      if (r.resultado !== "listo") return avanzar(r.resultado);
      if (!r.inicio || !r.appId || !r.configId || !r.version) return avanzar("meta");
      try {
        sdk.current = await cargarSdk({ appId: r.appId, version: r.version, idioma: locale === "en-US" ? "en_US" : "es_LA" });
      } catch {
        return avanzar("sdk_bloqueado");
      }
      apertura.current = { inicio: r.inicio, configId: r.configId, setup: r.setup, en: Date.now() };
      avanzar("listo");
    } catch {
      avanzar("meta");
    } finally {
      setOcupado(false);
    }
  }

  /** Va dentro del clic: nada de `await` antes de `FB.login`, o el navegador bloquea el popup. */
  function abrirPopup() {
    const a = apertura.current;
    if (!sdk.current || !a) return void preparar();
    setEstado({ vista: "esperando", aviso: null, paso: null, numeroMeta: null });
    void abrirRegistro({ fb: sdk.current, configId: a.configId, setup: a.setup }).then((salida) => terminarPopup(salida, a.inicio));
  }

  async function terminarPopup(salida: SalidaDelPopup, inicio: string) {
    if (salida.tipo === "cancelo") {
      setEstado({ vista: "cancelada", aviso: null, paso: salida.paso, numeroMeta: null });
      setAbierto(true);
      try {
        await cancelacionDeWabaPropia({ paso: salida.paso, codigo: salida.codigo });
      } catch {
        // Anotar la cancelación es información; la pantalla ya dijo lo que importa.
      }
      return;
    }
    // El código se gasta con este intento: el próximo popup trae un inicio nuevo.
    apertura.current = null;
    setOcupado(true);
    // `conectarWabaPropia` borra la cookie del sello y Next vuelve a renderizar la página con la respuesta:
    // un `router.refresh()` encima sería un segundo pedido al servidor para lo mismo.
    await correr(
      () =>
        conectarWabaPropia({
          inicio,
          code: salida.code,
          evento: salida.evento,
          wabaId: salida.wabaId,
          phoneNumberId: salida.phoneNumberId,
          userId: salida.userId,
        }),
      true
    );
  }

  /** «Reintentar»: lo que ya se puede seguir desde el servidor, o el popup otra vez (con el inicio de antes si no venció). */
  function reintentar() {
    const como = estado.vista === "cancelada" ? "popup" : estado.aviso ? reintentoDe(estado.aviso) : null;
    if (como === "servidor") return void correr(reintentarWabaPropia);
    if (como !== "popup") return;
    const a = apertura.current;
    if (sdk.current && a && Date.now() - a.en < FRESCURA_DEL_INICIO_MS) return abrirPopup();
    void preparar();
  }

  const textoDe = (aviso: Aviso) => t(`waba.r.${aviso}`);
  const aviso = estado.aviso && (
    <p
      role={estado.aviso === "codigo_enviado" ? "status" : "alert"}
      className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      {textoDe(estado.aviso)}
    </p>
  );
  const pie = (
    <div className="mt-5 flex flex-col items-center gap-2">
      <a href={SIGUE_EN} className={ENLACE}>
        {t("waba.porMail")}
      </a>
      {ayuda && (
        <a href={ayuda} className={ENLACE}>
          {t("waba.ayuda")}
        </a>
      )}
    </div>
  );
  const seguirDonde = (
    <>
      <p role="status" className="text-sm text-slate-600">
        {t("waba.faltaUnPaso")}
      </p>
      <button type="button" className={`${BOTON} mt-4`} onClick={() => setAbierto(true)}>
        {t("waba.seguirDonde")}
      </button>
    </>
  );

  const webValida = web.trim() === "" || /^https:\/\/\S+$/i.test(web.trim());
  const puedeContinuar = listaCompleta && nombre.trim() !== "" && webValida && !ocupado;

  return (
    <div>
      {estado.vista === "inicio" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (puedeContinuar) void preparar();
          }}
        >
          <p className="mb-5 text-sm text-slate-600">{t("waba.intro")}</p>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">{t("waba.antes.titulo")}</h2>
          <ul className="mb-4 list-disc space-y-2 pl-5 text-sm text-slate-600">
            <li>{t("waba.antes.facebook")}</li>
            <li>{numeroTipeado ? t("waba.antes.numero").replace("{numero}", numeroTipeado) : t("waba.antes.numeroSin")}</li>
            <li>{t("waba.antes.sms")}</li>
            <li>{t("waba.antes.nombre")}</li>
            <li>{t("waba.antes.pago")}</li>
          </ul>
          <label htmlFor={idNombre} className="mb-1.5 block text-sm font-medium text-slate-700">
            {t("waba.antes.nombreCampo")}
          </label>
          <input
            id={idNombre}
            type="text"
            value={nombre}
            maxLength={60}
            required
            autoComplete="organization"
            onChange={(e) => setNombre(e.target.value)}
            className={`${CAMPO} mb-4`}
          />
          <SelectorDeCategoria
            valor={categoria}
            alCambiar={setCategoria}
            ayuda="waba.antes.categoriaAyuda"
            className="mb-4"
          />
          <label htmlFor={idWeb} className="mb-1.5 block text-sm font-medium text-slate-700">
            {t("waba.antes.web")}
          </label>
          <input
            id={idWeb}
            type="url"
            inputMode="url"
            value={web}
            maxLength={200}
            placeholder="https://"
            autoComplete="url"
            aria-describedby={idWebAyuda}
            aria-invalid={!webValida}
            onChange={(e) => setWeb(e.target.value)}
            className={CAMPO}
          />
          <p id={idWebAyuda} className="mb-4 mt-1.5 text-xs text-slate-500">
            {t("waba.antes.webAyuda")}
          </p>
          <label className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              checked={listaCompleta}
              onChange={(e) => setListaCompleta(e.target.checked)}
              className="size-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
            />
            {t("waba.antes.confirmo")}
          </label>
          <p className="mb-4 ml-6 text-xs text-slate-500">{t("waba.antes.tiempo")}</p>
          {aviso}
          <button type="submit" disabled={!puedeContinuar} className={`${BOTON} mt-4`}>
            {ocupado ? t("waba.cargando") : t("waba.continuar")}
          </button>
          {pie}
        </form>
      )}

      {estado.vista === "abrir" && (
        <>
          <p role="status" className="mb-4 text-sm text-slate-600">
            {t("waba.abrir")}
          </p>
          <button type="button" className={BOTON} onClick={abrirPopup}>
            {t("waba.boton")}
          </button>
          {pie}
        </>
      )}

      {estado.vista === "esperando" && (
        <p role="status" className="text-sm text-slate-600">
          {ocupado ? t("waba.conectando") : t("waba.esperando")}
        </p>
      )}

      {estado.vista === "continuar" && (
        <>
          <p role="status" className="mb-4 text-sm text-slate-600">
            {t("waba.faltaUnPaso")}
          </p>
          <button type="button" disabled={ocupado} className={BOTON} onClick={() => void correr(reintentarWabaPropia)}>
            {ocupado ? t("waba.cargando") : t("waba.seguir")}
          </button>
          {aviso}
          {pie}
        </>
      )}

      {estado.vista === "falla" && (
        <>
          {aviso}
          {estado.aviso && reintentoDe(estado.aviso) && (
            <button type="button" disabled={ocupado} className={`${BOTON} mt-4`} onClick={reintentar}>
              {ocupado ? t("waba.cargando") : t("waba.reintentar")}
            </button>
          )}
          {pie}
        </>
      )}

      {(estado.vista === "numero_distinto" ||
        estado.vista === "codigo" ||
        estado.vista === "pin" ||
        estado.vista === "cancelada") && (
        <>
          {seguirDonde}
          {pie}
        </>
      )}

      {estado.vista === "conectado" && (
        <>
          <p role="status" className="mb-4 text-sm text-slate-700">
            {t("waba.conectado.texto").replace("{numero}", conectado.numero ?? "-")}
          </p>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">{t("waba.estado.titulo")}</h2>
          <ul className="mb-5 list-disc space-y-2 pl-5 text-sm text-slate-600">
            <li>{t(`waba.estado.nombre.${conectado.nombre ?? "sin"}`)}</li>
            <li>{t(conectado.plantilla ? "waba.estado.plantilla.enviada" : "waba.estado.plantilla.pendiente")}</li>
            <li>
              {t("waba.estado.pago")}{" "}
              <a href={WHATSAPP_MANAGER} target="_blank" rel="noopener noreferrer" className={ENLACE}>
                {t("waba.estado.pagoEnlace")}
              </a>
            </li>
          </ul>
          <a href={SIGUE_EN} className={`${BOTON} block`}>
            {t("waba.seguir")}
          </a>
          <button type="button" className={`${BOTON_SUAVE} mt-3`} onClick={() => setConfirmandoBaja(true)}>
            {t("waba.desconectar.boton")}
          </button>
          {ayuda && (
            <p className="mt-5 text-center">
              <a href={ayuda} className={ENLACE}>
                {t("waba.ayuda")}
              </a>
            </p>
          )}
        </>
      )}

      {estado.vista === "numero_distinto" && abierto && (
        <Dialogo
          titulo={t("waba.distinto.titulo")}
          texto={t("waba.distinto.texto")
            .replace("{numeroMeta}", estado.numeroMeta ?? "-")
            .replace("{numero}", numeroTipeado ?? "-")}
          alCerrar={() => setAbierto(false)}
        >
          <div className="flex flex-col gap-2">
            <button type="button" disabled={ocupado} className={BOTON} onClick={() => void correr(aceptarNumeroDeMeta)}>
              {ocupado ? t("waba.cargando") : t("waba.distinto.usar")}
            </button>
            <button type="button" disabled={ocupado} className={BOTON_SUAVE} onClick={() => void preparar()}>
              {t("waba.distinto.otro")}
            </button>
          </div>
        </Dialogo>
      )}

      {estado.vista === "codigo" && abierto && (
        <DialogoCodigo
          aviso={aviso}
          ocupado={ocupado}
          alCerrar={() => setAbierto(false)}
          pedir={(accion) => void correr(() => codigoDeWabaPropia({ accion }))}
          enviar={(codigo) => void correr(() => codigoDeWabaPropia({ accion: "verificar", codigo }))}
        />
      )}

      {estado.vista === "pin" && abierto && (
        <DialogoPin
          aviso={aviso}
          ocupado={ocupado}
          alCerrar={() => setAbierto(false)}
          enviar={(pin) => void correr(() => pinDeWabaPropia({ pin }))}
        />
      )}

      {estado.vista === "cancelada" && abierto && (
        <Dialogo
          titulo={t("waba.cancelado.titulo")}
          texto={t(`waba.cancelado.${estado.paso ?? "otro"}`)}
          alCerrar={() => setAbierto(false)}
        >
          <div className="flex flex-col gap-2">
            <button type="button" disabled={ocupado} className={BOTON} onClick={reintentar}>
              {ocupado ? t("waba.cargando") : t("waba.reintentar")}
            </button>
            <a href={SIGUE_EN} className={BOTON_SUAVE}>
              {t("waba.porMail")}
            </a>
          </div>
        </Dialogo>
      )}

      {confirmandoBaja && (
        <Dialogo
          titulo={t("waba.desconectar.titulo")}
          texto={t("waba.desconectar.texto")}
          alCerrar={() => setConfirmandoBaja(false)}
          foco={cancelarBaja}
        >
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={ocupado}
              className={BOTON}
              onClick={() => {
                setConfirmandoBaja(false);
                setListaCompleta(false);
                apertura.current = null;
                void correr(desconectarWabaPropia);
              }}
            >
              {t("waba.desconectar.confirmar")}
            </button>
            <button ref={cancelarBaja} type="button" className={BOTON_SUAVE} onClick={() => setConfirmandoBaja(false)}>
              {t("waba.cancelar")}
            </button>
          </div>
        </Dialogo>
      )}
    </div>
  );
}

/** El marco de los diálogos: foco adentro, Escape cierra, el fondo no se toca. */
export function Dialogo({
  titulo,
  texto,
  alCerrar,
  foco,
  children,
}: {
  titulo: string;
  texto: string;
  alCerrar: () => void;
  foco?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panel = useDialogoModal<HTMLDivElement>(alCerrar, foco);
  const idTitulo = useId();
  const idTexto = useId();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={idTitulo}
      aria-describedby={idTexto}
    >
      <div ref={panel} className="max-h-full w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 id={idTitulo} className="mb-2 text-base font-semibold text-slate-900">
          {titulo}
        </h2>
        <p id={idTexto} className="mb-4 text-sm text-slate-600">
          {texto}
        </p>
        {children}
      </div>
    </div>
  );
}

export function DialogoCodigo({
  aviso,
  ocupado,
  alCerrar,
  pedir,
  enviar,
}: {
  aviso: ReactNode;
  ocupado: boolean;
  alCerrar: () => void;
  pedir: (accion: "SMS" | "VOICE") => void;
  enviar: (codigo: string) => void;
}) {
  const t = useT();
  const [codigo, setCodigo] = useState("");
  const campo = useRef<HTMLInputElement>(null);
  const idCampo = useId();
  // El SMS a veces trae un espacio en el medio («123 456»): no cuenta.
  const limpio = codigo.replace(/\s+/g, "");
  return (
    <Dialogo titulo={t("waba.codigo.titulo")} texto={t("waba.codigo.ayuda")} alCerrar={alCerrar} foco={campo}>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <button type="button" disabled={ocupado} className={BOTON_SUAVE} onClick={() => pedir("SMS")}>
          {t("waba.codigo.sms")}
        </button>
        <button type="button" disabled={ocupado} className={BOTON_SUAVE} onClick={() => pedir("VOICE")}>
          {t("waba.codigo.llamada")}
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (DE_SEIS.test(limpio) && !ocupado) enviar(limpio);
        }}
      >
        <label htmlFor={idCampo} className="mb-1.5 block text-sm font-medium text-slate-700">
          {t("waba.codigo.campo")}
        </label>
        <input
          ref={campo}
          id={idCampo}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={10}
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          className={CAMPO}
        />
        {aviso}
        <div className="mt-4 flex flex-col gap-2">
          <button type="submit" disabled={ocupado || !DE_SEIS.test(limpio)} className={BOTON}>
            {ocupado ? t("waba.cargando") : t("waba.codigo.enviar")}
          </button>
          <button type="button" className={BOTON_SUAVE} onClick={alCerrar}>
            {t("waba.cancelar")}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}

export function DialogoPin({
  aviso,
  ocupado,
  alCerrar,
  enviar,
}: {
  aviso: ReactNode;
  ocupado: boolean;
  alCerrar: () => void;
  enviar: (pin: string) => void;
}) {
  const t = useT();
  const [pin, setPin] = useState("");
  const campo = useRef<HTMLInputElement>(null);
  const idCampo = useId();
  return (
    <Dialogo titulo={t("waba.pin.titulo")} texto={t("waba.pin.ayuda")} alCerrar={alCerrar} foco={campo}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (DE_SEIS.test(pin) && !ocupado) enviar(pin);
        }}
      >
        <label htmlFor={idCampo} className="mb-1.5 block text-sm font-medium text-slate-700">
          {t("waba.pin.campo")}
        </label>
        <input
          ref={campo}
          id={idCampo}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className={CAMPO}
        />
        {aviso}
        <div className="mt-4 flex flex-col gap-2">
          <button type="submit" disabled={ocupado || !DE_SEIS.test(pin)} className={BOTON}>
            {ocupado ? t("waba.cargando") : t("waba.pin.enviar")}
          </button>
          <button type="button" className={BOTON_SUAVE} onClick={alCerrar}>
            {t("waba.cancelar")}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}
