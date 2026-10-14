/**
 * Las ventanas del asistente de «app propia» (E2 a E12): lo que se abre encima de la pantalla cuando Meta o
 * el servidor piden algo puntual. Las del código por SMS, el PIN y el marco son las del alta por Facebook.
 *
 * Cada una cierra con el resultado del servidor: lo que cambia lo que lee la página se refresca desde el
 * panel y esta ventana se va con la pantalla vieja.
 */

"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";

import { useT } from "@/lib/i18n/LocaleContext";
import type { ResultadoDeApp } from "@/server/alta/waba-resultados";

import {
  aceptarNumeroDeMeta,
  codigoDeWabaPropia,
  credencialesDeAppPropia,
  cancelarAppPropia,
  desconectarWabaPropia,
  nombreDeAppPropia,
  pinDeWabaPropia,
  reintentarWabaPropia,
  tokenDeAppPropia,
} from "../actions";
import { BOTON, BOTON_SUAVE, CAMPO, Dialogo, DialogoCodigo, DialogoPin, ENLACE, WHATSAPP_MANAGER } from "../WabaPropiaPanel";
import { Ayuda, AvisoDeResultado, CampoSecreto, type ControlDelPanel } from "./piezas";
import { rellenar, tokenGuardado, type Pantalla, type Ventana } from "./vista";

const NOMBRE_MAX = 60;

function EnlaceAlGestor({ children }: { children: string }) {
  return (
    <a href={WHATSAPP_MANAGER} target="_blank" rel="noopener noreferrer" className={`${ENLACE} text-center`}>
      {children}
    </a>
  );
}

/** Dos botones: el principal y el que cierra. */
function Botones({ control, principal }: { control: ControlDelPanel; principal: ReactNode }) {
  const t = useT();
  return (
    <div className="mt-4 flex flex-col gap-2">
      {principal}
      <button type="button" className={BOTON_SUAVE} onClick={control.cerrar}>
        {t("appPropia.cerrar")}
      </button>
    </div>
  );
}

/** Una ventana que sólo cuenta qué pasó y dónde seguir. */
function VentanaDeAviso({ texto, control, enlace, reintento }: { texto: string; control: ControlDelPanel; enlace?: boolean; reintento?: boolean }) {
  const t = useT();
  return (
    <Dialogo titulo={t("appPropia.ventana.aviso")} texto={texto} alCerrar={control.cerrar}>
      <div className="flex flex-col gap-2">
        {enlace && <EnlaceAlGestor>{t("waba.estado.pagoEnlace")}</EnlaceAlGestor>}
        <AvisoDeResultado aviso={control.aviso} />
      </div>
      <Botones
        control={control}
        principal={
          reintento && (
            <button type="button" disabled={control.ocupado} className={BOTON} onClick={() => void control.correr(reintentarWabaPropia)}>
              {control.ocupado ? t("waba.cargando") : t("waba.reintentar")}
            </button>
          )
        }
      />
      <Ayuda ayuda={control.ayuda} />
    </Dialogo>
  );
}

/** E2: la cuenta de WhatsApp tiene varios números; se vuelve a mandar el token con el elegido. */
function VentanaDeNumeros({
  numeros,
  control,
  elegir,
}: {
  numeros: { id: string; display: string }[];
  control: ControlDelPanel;
  elegir: (phoneNumberId: string) => void;
}) {
  const t = useT();
  return (
    <Dialogo titulo={t("appPropia.elegir.titulo")} texto={t("appPropia.elegir.texto")} alCerrar={control.cerrar}>
      <ul className="flex flex-col gap-2">
        {numeros.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
            <span className="min-w-0 break-all text-sm text-slate-800">{n.display}</span>
            <button
              type="button"
              disabled={control.ocupado}
              className="shrink-0 rounded-full bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
              onClick={() => elegir(n.id)}
            >
              {t("appPropia.elegir.usar")}
            </button>
          </li>
        ))}
      </ul>
      <AvisoDeResultado aviso={control.aviso} />
      <button type="button" className={`${BOTON_SUAVE} mt-4`} onClick={control.cerrar}>
        {t("waba.cancelar")}
      </button>
    </Dialogo>
  );
}

/**
 * E5: Meta informó otro número. Se puede quedar con ese o elegir otro: «otro» vuelve al paso de sumar el número
 * y a pegar el token. No desconecta: ClaimMix no registró ese número y la cuenta sigue siendo la del cliente.
 */
function VentanaDeNumeroDistinto({
  numeroMeta,
  numeroTipeado,
  control,
  elegirOtro,
}: {
  numeroMeta: string | null;
  numeroTipeado: string | null;
  control: ControlDelPanel;
  elegirOtro: () => void;
}) {
  const t = useT();
  const texto = rellenar(t("waba.distinto.texto"), { numeroMeta: numeroMeta ?? "-", numero: numeroTipeado ?? "-" });
  return (
    <Dialogo titulo={t("waba.distinto.titulo")} texto={`${texto} ${t("appPropia.distinto.prueba")}`} alCerrar={control.cerrar}>
      <AvisoDeResultado aviso={control.aviso} />
      <div className="mt-4 flex flex-col gap-2">
        <button type="button" disabled={control.ocupado} className={BOTON} onClick={() => void control.correr(aceptarNumeroDeMeta)}>
          {control.ocupado ? t("waba.cargando") : t("waba.distinto.usar")}
        </button>
        <button type="button" disabled={control.ocupado} className={BOTON_SUAVE} onClick={elegirOtro}>
          {t("waba.distinto.otro")}
        </button>
      </div>
      <Ayuda ayuda={control.ayuda} />
    </Dialogo>
  );
}

/** Una ventana con un único secreto para pegar (E6, token; E7, clave secreta). */
function VentanaDeSecreto({
  titulo,
  texto,
  etiqueta,
  maxLength,
  control,
  appId,
  mandar,
}: {
  titulo: string;
  texto: string;
  etiqueta: string;
  maxLength: number;
  control: ControlDelPanel;
  appId: string | null;
  mandar: (secreto: string) => Promise<{ resultado: ResultadoDeApp }>;
}) {
  const t = useT();
  const [secreto, setSecreto] = useState("");

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (secreto.trim() === "" || control.ocupado) return;
    const r = await control.correr(() => mandar(secreto.trim()));
    if (tokenGuardado(r)) setSecreto("");
  }

  return (
    <Dialogo titulo={titulo} texto={texto} alCerrar={control.cerrar}>
      <form onSubmit={(e) => void enviar(e)}>
        <CampoSecreto etiqueta={etiqueta} valor={secreto} alCambiar={setSecreto} maxLength={maxLength} />
        <AvisoDeResultado aviso={control.aviso} appId={appId} />
        <div className="mt-4 flex flex-col gap-2">
          <button type="submit" disabled={control.ocupado || secreto.trim() === ""} className={BOTON}>
            {control.ocupado ? t("appPropia.validando") : t("appPropia.validar")}
          </button>
          <button type="button" className={BOTON_SUAVE} onClick={control.cerrar}>
            {t("waba.cancelar")}
          </button>
        </div>
      </form>
      <Ayuda ayuda={control.ayuda} />
    </Dialogo>
  );
}

/** E10: Meta rechazó el nombre visible; se manda otro a revisión, o se le pregunta a Meta cómo va el que ya se mandó (`reintento`). */
function VentanaDeNombre({ inicial, control, reintento }: { inicial: string; control: ControlDelPanel; reintento: boolean }) {
  const t = useT();
  const [nombre, setNombre] = useState(inicial.slice(0, NOMBRE_MAX));
  const puede = nombre.trim() !== "" && !control.ocupado;
  const idCampo = useId();
  return (
    <Dialogo titulo={t("appPropia.nombre.titulo")} texto={t("appPropia.r.nombre_rechazado")} alCerrar={control.cerrar}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (puede) void control.correr(() => nombreDeAppPropia({ nombre: nombre.trim() }));
        }}
      >
        <label htmlFor={idCampo} className="mb-1.5 block text-sm font-medium text-slate-700">
          {t("appPropia.nombre.campo")}
        </label>
        <input
          id={idCampo}
          type="text"
          maxLength={NOMBRE_MAX}
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          className={CAMPO}
        />
        <p className="mt-1.5 text-xs text-slate-500">{t("appPropia.nombre.tope")}</p>
        <AvisoDeResultado aviso={control.aviso} />
        <div className="mt-4 flex flex-col gap-2">
          <button type="submit" disabled={!puede} className={BOTON}>
            {control.ocupado ? t("waba.cargando") : t("appPropia.nombre.mandar")}
          </button>
          {reintento && (
            <button type="button" disabled={control.ocupado} className={BOTON_SUAVE} onClick={() => void control.correr(reintentarWabaPropia)}>
              {t("waba.reintentar")}
            </button>
          )}
          <button type="button" className={BOTON_SUAVE} onClick={control.cerrar}>
            {t("waba.cancelar")}
          </button>
        </div>
      </form>
      <Ayuda ayuda={control.ayuda} />
    </Dialogo>
  );
}

/** Confirmar la baja: avisa qué hacemos nosotros y qué queda por hacer en Meta. */
export function VentanaDeBaja({ control, cancelar }: { control: ControlDelPanel; cancelar: () => void }) {
  const t = useT();
  return (
    <Dialogo titulo={t("waba.desconectar.titulo")} texto={t("appPropia.desconectar.confirmar")} alCerrar={cancelar}>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={control.ocupado}
          className={BOTON}
          onClick={() => {
            cancelar();
            void control.correr(desconectarWabaPropia);
          }}
        >
          {t("waba.desconectar.confirmar")}
        </button>
        <button type="button" className={BOTON_SUAVE} onClick={cancelar}>
          {t("waba.cancelar")}
        </button>
      </div>
    </Dialogo>
  );
}

/** Confirmar que se empieza de nuevo: la fila se cierra y la persona vuelve a elegir cómo conectar. */
export function VentanaDeCancelar({ control, volver }: { control: ControlDelPanel; volver: () => void }) {
  const t = useT();
  return (
    <Dialogo titulo={t("appPropia.cancelar.titulo")} texto={t("appPropia.cancelar.texto")} alCerrar={volver}>
      <AvisoDeResultado aviso={control.aviso} />
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          disabled={control.ocupado}
          className={BOTON}
          onClick={() => {
            volver();
            void control.correr(cancelarAppPropia);
          }}
        >
          {t("appPropia.cancelar.confirmar")}
        </button>
        <button type="button" className={BOTON_SUAVE} onClick={volver}>
          {t("appPropia.cancelar.volver")}
        </button>
      </div>
    </Dialogo>
  );
}

export interface VentanasProps {
  ventana: Ventana;
  pantalla: Pantalla;
  control: ControlDelPanel;
  appId: string | null;
  empresa: string;
  numeroTipeado: string | null;
  /** E10: la fila quedó en falla por el nombre; sólo entonces hay algo que reintentar. */
  nombreRechazado: boolean;
  /** E2: vuelve a mandar el token que está en el panel con el número elegido. */
  elegirNumero: (phoneNumberId: string) => void;
  /** E5: cierra la ventana y vuelve al paso de sumar el número. */
  elegirOtro: () => void;
}

/** La ventana que toca según el resultado del servidor o la falla guardada. */
export function Ventanas({ ventana, pantalla, control, appId, empresa, numeroTipeado, nombreRechazado, elegirNumero, elegirOtro }: VentanasProps) {
  const t = useT();
  switch (ventana.tipo) {
    case "E2":
      return <VentanaDeNumeros numeros={ventana.numeros} control={control} elegir={elegirNumero} />;
    case "E3":
      return (
        <DialogoCodigo
          aviso={<AvisoDeResultado aviso={control.aviso} />}
          ocupado={control.ocupado}
          alCerrar={control.cerrar}
          pedir={(accion) => void control.correr(() => codigoDeWabaPropia({ accion }))}
          enviar={(codigo) => void control.correr(() => codigoDeWabaPropia({ accion: "verificar", codigo }))}
        />
      );
    case "E4":
      return (
        <DialogoPin
          aviso={
            <>
              <AvisoDeResultado aviso={control.aviso} />
              {control.aviso?.resultado === "pin_incorrecto" && <p className="mt-2 text-xs text-slate-500">{t("appPropia.pin.olvide")}</p>}
            </>
          }
          ocupado={control.ocupado}
          alCerrar={control.cerrar}
          enviar={(pin) => void control.correr(() => pinDeWabaPropia({ pin }))}
        />
      );
    case "E5":
      return <VentanaDeNumeroDistinto numeroMeta={ventana.numeroMeta} numeroTipeado={numeroTipeado} control={control} elegirOtro={elegirOtro} />;
    case "E6":
      return (
        <VentanaDeSecreto
          titulo={t("appPropia.token.nuevoTitulo")}
          texto={t("appPropia.token.nuevoTexto")}
          etiqueta={t("appPropia.token.campo")}
          maxLength={2048}
          control={control}
          appId={appId}
          mandar={(token) => tokenDeAppPropia({ token, wabaId: "" })}
        />
      );
    case "E7":
      return (
        <VentanaDeSecreto
          titulo={t("appPropia.claves.nuevoTitulo")}
          texto={t("appPropia.claves.nuevoTexto")}
          etiqueta={t("appPropia.claves.campoSecreto")}
          maxLength={128}
          control={control}
          appId={appId}
          mandar={(secreto) => credencialesDeAppPropia({ appId: appId ?? "", secreto })}
        />
      );
    case "E8":
      return <VentanaDeAviso texto={t("appPropia.r.pago_pendiente")} control={control} enlace />;
    case "E9":
      // Pegando el token todavía no hay nada guardado que reintentar: se vuelve a validar desde el paso.
      return <VentanaDeAviso texto={t("waba.r.coexistencia")} control={control} reintento={pantalla !== "P3"} />;
    case "E10":
      return <VentanaDeNombre inicial={empresa} control={control} reintento={nombreRechazado} />;
    case "E11":
      return <VentanaDeAviso texto={t("waba.r.esperar")} control={control} />;
    case "E12":
      return <VentanaDeAviso texto={t(ventana.bloqueada ? "appPropia.r.waba_bloqueada" : "appPropia.r.waba_restringida")} control={control} enlace />;
  }
}
