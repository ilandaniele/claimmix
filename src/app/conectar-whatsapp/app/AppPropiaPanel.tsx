/**
 * El asistente de «app propia» de /conectar-whatsapp/app: lleva a la persona por los cuatro pasos de
 * Meta (crear la app, sumar el número, el usuario del sistema y la prueba) y por las ventanas de lo que
 * puede salir distinto.
 *
 * Qué pantalla toca lo dice el servidor (`pasoDelAsistente`); acá sólo se decide qué ventana abre cada
 * resultado (`vista.ts`, puro) y qué se cuenta mientras tanto. Lo que guarda el servidor cambia lo que lee la
 * página: se refresca y el panel se vuelve a armar con la pantalla nueva (la `key` cambia con el paso).
 *
 * Esta ruta vive fuera de `(app)` y no tiene `LocaleProvider`, así que lo trae acá.
 */

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ClaveDePagina, Locale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { CATEGORIA_INICIAL, type CategoriaDePerfil } from "@/lib/whatsapp-categorias";
import type { EstadoDeApp, LegalesDeApp, PasoDelAsistente } from "@/server/alta/app-propia";
import type { ResultadoDeApp } from "@/server/alta/waba-resultados";

import { reintentarWabaPropia, tokenDeAppPropia } from "../actions";
import type { ControlDelPanel } from "./piezas";
import { PasoApp, PasoCuenta, PasoDatos, PasoGestion, PasoInicial, PasoPrueba, PasoSeguir, PasoUsuario, PasoWebhook } from "./pasos";
import { Ventanas, VentanaDeBaja, VentanaDeCancelar } from "./ventanas";
import {
  pantallaDe,
  pantallaDeResultado,
  pideRefrescar,
  sigueEnElServidor,
  tokenGuardado,
  ventanaDe,
  ventanaDeResultado,
  type Aviso,
  type Extras,
  type Pantalla,
  type Ventana,
} from "./vista";

export interface AppPropiaPanelProps {
  paso: PasoDelAsistente;
  estado: EstadoDeApp | null;
  /** El número que la persona escribió al registrarse. */
  numeroTipeado: string | null;
  /** El nombre del espacio: va en el nombre sugerido de la app y en el del número. */
  empresa: string;
  locale: Locale;
  textos: Record<ClaveDePagina, string>;
  /** `mailto:` a quien atiende los avisos del alta; null si no hay dirección. */
  ayuda: string | null;
  /** Sólo en P1B: las direcciones de los términos, la privacidad y el borrado, y si están listas. */
  legales?: LegalesDeApp;
  /** Sólo en P1B, E14 y «seguir» (E14 se abre ahí si el callback de la app cambió): la dirección y la marca que se pegan en la app. */
  webhook?: { url: string; verifyToken: string };
}

export function AppPropiaPanel(props: AppPropiaPanelProps) {
  // Si el servidor cambia de paso o de estado, el panel arranca de cero con la pantalla nueva.
  const clave = `${props.paso}|${props.estado?.estado ?? ""}|${props.estado?.falla ?? ""}`;
  return (
    <LocaleProvider locale={props.locale} textos={props.textos}>
      <Panel key={clave} {...props} />
    </LocaleProvider>
  );
}

function Panel({ paso, estado, numeroTipeado, empresa, ayuda, legales, webhook }: AppPropiaPanelProps) {
  const router = useRouter();
  const [pantalla, setPantalla] = useState<Pantalla>(pantallaDe(paso));
  const [ventana, setVentana] = useState<Ventana | null>(() => ventanaDe(paso, estado));
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [vueltaDeWebhook, setVueltaDeWebhook] = useState(0);
  const [ocupado, setOcupado] = useState(false);
  const [confirmandoBaja, setConfirmandoBaja] = useState(false);
  const [confirmandoCancelar, setConfirmandoCancelar] = useState(false);
  const [token, setToken] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [categoria, setCategoria] = useState<CategoriaDePerfil>(CATEGORIA_INICIAL);

  async function correr(accion: () => Promise<{ resultado: ResultadoDeApp } & Extras>): Promise<ResultadoDeApp> {
    setOcupado(true);
    try {
      const r = await accion();
      const proxima = ventanaDeResultado(r.resultado, r);
      const destino = pantallaDeResultado(r.resultado);
      if (destino) {
        setPantalla(destino);
        // E14 mira el callback al abrirse: ya abierta, se vuelve a montar para que lo mire de nuevo.
        setVueltaDeWebhook((v) => v + 1);
      }
      // Una ventana propia o una pantalla de destino ya cuentan lo que pasó; la que sigue a la página nueva no necesita cartel.
      setAviso(proxima || destino || sigueEnElServidor(r.resultado) ? null : { resultado: r.resultado, permiso: r.permiso, permisos: r.permisos });
      // Un resultado sin ventana propia (código incorrecto, PIN incorrecto) deja abierta la que había.
      setVentana((antes) => (sigueEnElServidor(r.resultado) ? null : (proxima ?? antes)));
      if (pideRefrescar(r.resultado, proxima)) router.refresh();
      return r.resultado;
    } catch {
      setAviso({ resultado: "meta" });
      return "meta";
    } finally {
      setOcupado(false);
    }
  }

  async function validarToken(phoneNumberId?: string) {
    const r = await correr(() => tokenDeAppPropia({ token: token.trim(), wabaId: wabaId.trim(), phoneNumberId, categoria }));
    if (tokenGuardado(r)) setToken("");
  }

  function abrir(v: Ventana) {
    setAviso(null);
    setVentana(v);
  }

  const control: ControlDelPanel = {
    ocupado,
    aviso,
    ayuda,
    correr,
    abrir,
    cerrar: () => {
      setAviso(null);
      setVentana(null);
    },
    pedirBaja: () => setConfirmandoBaja(true),
    // Sólo mientras se arma: con la app ya vinculada, salir es desconectar y baja en Meta (PasoGestion).
    pedirCancelar: estado?.estado === "armando" ? () => setConfirmandoCancelar(true) : undefined,
  };
  // Con una ventana abierta, el aviso va en la ventana y no se repite en la pantalla de atrás.
  const deFondo: ControlDelPanel = ventana ? { ...control, aviso: null } : control;
  const alSeguir = () => {
    const v = ventanaDe(paso, estado);
    if (v) abrir(v);
    else void correr(reintentarWabaPropia);
  };

  return (
    <div>
      {pantalla === "P0" && <PasoInicial control={deFondo} numeroTipeado={numeroTipeado} />}
      {pantalla === "P1" && <PasoApp control={deFondo} empresa={empresa} />}
      {pantalla === "P1B" && <PasoDatos control={deFondo} legales={legales} avanzar={() => setPantalla("E14")} />}
      {pantalla === "E14" && (
        <PasoWebhook
          key={vueltaDeWebhook}
          control={deFondo}
          webhook={webhook}
          alVerificar={() => router.refresh()}
          reanudar={estado?.webhookVerificado ? () => void correr(reintentarWabaPropia) : undefined}
        />
      )}
      {pantalla === "P2" && (
        <PasoCuenta
          control={deFondo}
          numero={numeroTipeado ?? estado?.numero ?? null}
          categoria={categoria}
          alCambiarCategoria={setCategoria}
          avanzar={() => setPantalla("P3")}
        />
      )}
      {pantalla === "P3" && (
        <PasoUsuario
          control={deFondo}
          appId={estado?.appId ?? null}
          token={token}
          wabaId={wabaId}
          alCambiarToken={setToken}
          alCambiarWaba={setWabaId}
          validar={() => void validarToken()}
        />
      )}
      {pantalla === "P4" && <PasoPrueba control={deFondo} estado={estado} />}
      {pantalla === "G" && <PasoGestion control={deFondo} estado={estado} />}
      {pantalla === "seguir" && <PasoSeguir control={deFondo} alSeguir={alSeguir} />}

      {ventana && (
        <Ventanas
          ventana={ventana}
          pantalla={pantalla}
          control={control}
          appId={estado?.appId ?? null}
          empresa={empresa}
          numeroTipeado={numeroTipeado}
          nombreRechazado={estado?.estado === "falla" && estado.falla === "nombre_rechazado"}
          elegirNumero={(id) => void validarToken(id)}
          elegirOtro={() => {
            control.cerrar();
            setPantalla("P2");
          }}
        />
      )}
      {confirmandoBaja && <VentanaDeBaja control={control} cancelar={() => setConfirmandoBaja(false)} />}
      {confirmandoCancelar && <VentanaDeCancelar control={control} volver={() => setConfirmandoCancelar(false)} />}
    </div>
  );
}
