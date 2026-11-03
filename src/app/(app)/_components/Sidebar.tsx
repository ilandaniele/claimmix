"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { ADMIN_ROLES, CUSTOMER_PII_ROLES, REVISION_ROLES } from "@/lib/auth/roles";
import { usePathname, useSearchParams } from "next/navigation";
import { hrefActivo } from "./nav-activo";
import { useDialogoModal } from "./dialogo-modal";
import { useT } from "@/lib/i18n/LocaleContext";
import type { ClaveDelCliente } from "@/lib/i18n";
import { cookieDeLaBarra } from "@/lib/ui/barra-shared";
import {
  ChevronRight,
  Menu,
  X,
  Inbox,
  AlertTriangle,
  Users,
  BarChart2,
  Settings,
  Shield,
  Brain,
  Lock,
  Play,
  Receipt,
  Briefcase,
  UserPlus,
  MailX,
  MessageSquareReply,
  Sparkles,
  ListTodo,
  CalendarClock,
  ClipboardCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItemDef {
  label: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
  disabledReason?: string;
  /** Función del Plan Pro: sin ese plan, el ítem se ve con candado. */
  pro?: true;
  /** Lo que va en lugar del candado pelado, p. ej. «Plan Pro». */
  insignia?: string;
}

/*
 * Se deshabilita y no se esconde, al revés que «Clientes»: acá no hay datos
 * de terceros del otro lado, y que la función exista es justamente lo que el
 * plan vende. La guarda sigue siendo `exigirPlanPro` en el servidor.
 */
export function conCandadoPro(
  items: NavItemDef[],
  esPro: boolean,
  t: (k: ClaveDelCliente) => string
): NavItemDef[] {
  if (esPro) return items;
  return items.map((item) =>
    item.pro
      ? { ...item, disabled: true, disabledReason: t("planPro.bloqueado"), insignia: t("planPro.nombre") }
      : item
  );
}

/*
 * `active` viene de afuera. Cada item lo calculaba solo mirando el
 * `pathname`, y eso alcanzaba mientras cada item fuera una ruta distinta.
 * Desde que «Escalados» apunta a `/bandeja?status=escalado`, dos items
 * comparten camino: la lista decide cual se resalta —ver `nav-activo.ts`—
 * y el item solo lo dibuja.
 *
 * `contraida` sólo pone el rótulo de tooltip: lo que esconde el texto cuando la
 * barra está contraída es la hoja de estilos (`.barra-texto`, en `globals.css`),
 * que además llega al indicador del agente, un componente de servidor.
 */
type NavLinkProps = NavItemDef & { active: boolean; contraida?: boolean };

export function NavLink({
  href,
  label,
  icon: Icon,
  disabled,
  disabledReason,
  insignia,
  active,
  contraida,
}: NavLinkProps) {
  const isActive = active;

  if (disabled) {
    return (
      <div
        aria-disabled="true"
        title={contraida ? [label, disabledReason].filter(Boolean).join(" · ") : disabledReason}
        /*
         * El ítem deshabilitado tiene que verse MENOS que los habilitados, y
         * durante un tiempo se vio más.
         *
         * La causa no estaba acá: `dark:text-slate-600` estaba escrito, pero el
         * variante `dark:` de Tailwind seguía al tema del SISTEMA y no a la
         * clase `.dark` que pone el botón del producto, así que en una máquina
         * con el sistema en claro no llegaba nunca y quedaba el
         * `text-slate-300` del modo claro: gris clarito sobre fondo oscuro.
         *
         * Se arregló en `globals.css` con `@custom-variant dark`, que es de
         * dónde salía el problema. Las dos clases de acá son correctas y ahora
         * además se aplican.
         */
        className="barra-item flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2 text-slate-300 md:py-1.5 dark:text-slate-600"
      >
        <Icon size={17} className="text-slate-300 dark:text-slate-600" />
        <span className="barra-texto text-[13.5px]">{label}</span>
        {insignia ? (
          <span className="barra-texto ml-auto inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 text-[10.5px] font-medium text-violet-700">
            <Lock size={10} />
            {insignia}
          </span>
        ) : (
          <Lock size={12} className="barra-texto ml-auto text-slate-300 dark:text-slate-600" />
        )}
      </div>
    );
  }

  return (
    <Link
      href={href}
      title={contraida ? label : undefined}
      aria-current={isActive ? "page" : undefined}
      className={[
        // El anillo de foco, con el acento nuevo. `focus-visible` y no `focus`:
        // así aparece para quien navega con teclado y no en cada clic del mouse.
        "barra-item flex items-center gap-3 rounded-xl px-3 py-2 transition-colors md:py-1.5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1",
        isActive
          ? "bg-violet-50 text-violet-700 font-semibold"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      ].join(" ")}
    >
      <Icon
        size={17}
        className={
          isActive
            ? "text-violet-700"
            : "text-slate-400"
        }
      />
      <span className="barra-texto text-[13.5px]">{label}</span>
    </Link>
  );
}

/*
 * El cajón del teléfono, montado sólo mientras está abierto.
 *
 * `useDialogoModal` pone el foco adentro, atrapa el Tab, cierra con Escape y
 * devuelve el foco al botón del menú. Si corriera siempre, en escritorio le
 * robaría el foco a la página al cargar y le atraparía el Tab: por eso el
 * cajón es un componente aparte que existe nada más cuando se abrió.
 *
 * Se cierra al tocar un enlace —incluido el de la pantalla en la que ya se está,
 * que no cambia la ruta y no lo cerraría de otro modo— y al pasar a escritorio
 * (girar el teléfono), donde el cajón deja de serlo y la trampa de foco sobraría.
 */
function Cajon({ alCerrar, children }: { alCerrar: () => void; children: React.ReactNode }) {
  const t = useT();
  const panel = useDialogoModal<HTMLDivElement>(alCerrar);

  useEffect(() => {
    const escritorio = window.matchMedia("(min-width: 48rem)");
    const alCambiar = (e: MediaQueryListEvent) => {
      if (e.matches) alCerrar();
    };
    escritorio.addEventListener("change", alCambiar);
    return () => escritorio.removeEventListener("change", alCambiar);
  }, [alCerrar]);

  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={t("nav.principal")}
      className="contents"
      onClick={(e) => {
        if ((e.target as Element).closest("a")) alCerrar();
      }}
    >
      {children}
    </div>
  );
}

export function Sidebar({
  role,
  isOperator = false,
  esPro = false,
  contraida: contraidaInicial = false,
  estadoDelAgente,
}: {
  role: string;
  /** Quien opera ClaimMix, no el asegurador. Ve la cartera y las altas. */
  isOperator?: boolean;
  /** Sin el Plan Pro, lo del Plan Pro va con candado. */
  esPro?: boolean;
  /** Si la barra arranca contraída a íconos: lo lee el layout de la cookie, para que no parpadee. */
  contraida?: boolean;
  /** El indicador del agente (`EstadoDelAgente`), servido ya resuelto por el layout. */
  estadoDelAgente?: React.ReactNode;
}) {
  const t = useT();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [contraida, setContraida] = useState(contraidaInicial);
  const [abierto, setAbierto] = useState(false);
  const cerrar = useCallback(() => setAbierto(false), []);

  // Cambiar de pantalla cierra el cajón. Ajuste de estado en el render y no un
  // efecto, que es lo que prescribe `react-hooks/set-state-in-effect`.
  const ruta = `${pathname}?${searchParams.toString()}`;
  const [rutaVista, setRutaVista] = useState(ruta);
  if (rutaVista !== ruta) {
    setRutaVista(ruta);
    setAbierto(false);
  }

  function alternar() {
    setContraida(!contraida);
    document.cookie = cookieDeLaBarra(!contraida);
  }

  const esAdmin = (ADMIN_ROLES as string[]).includes(role);
  const puedeVerClientes = (CUSTOMER_PII_ROLES as string[]).includes(role);
  const puedeRevisar = (REVISION_ROLES as string[]).includes(role);

  const operacionItems: NavItemDef[] = conCandadoPro([
    { label: t("nav.miCola"), href: "/bandeja?cola=mia", icon: ListTodo },
    { label: t("nav.bandeja"), href: "/bandeja", icon: Inbox },
    { label: t("bandeja.paraResponder"), href: "/bandeja?para_responder=true", icon: MessageSquareReply },
    /*
     * Directo a la bandeja filtrada. `/escalados` era una pagina de nueve
     * lineas que hacia `redirect` aca mismo: un click, dos viajes al
     * servidor. La pagina sigue existiendo para quien tenga el enlace
     * guardado; la barra ya no pasa por ella.
     */
    { label: t("nav.escalados"), href: "/bandeja?status=escalado", icon: AlertTriangle },
    { label: t("nav.noRelevantes"), href: "/bandeja?is_claim=false", icon: MailX },
    // D-D1: la abre cualquier rol; `leerAgenda` tapa el titular por su cuenta.
    { label: t("nav.agenda"), href: "/agenda", icon: CalendarClock },
    /*
     * «Clientes» sólo para quien puede ver datos personales.
     *
     * Estaba sin condición, así que un analista y un viewer lo veían en la barra
     * permanente, lo apretaban, y `clientes/page.tsx` los mandaba de vuelta a
     * /bandeja sin decir nada. Un enlace que siempre está y nunca funciona se
     * lee como que el producto está roto, no como que no les corresponde.
     *
     * Se esconde y no se deshabilita —al revés que «Agente», que sí se
     * deshabilita con su motivo— porque acá lo que está del otro lado son datos
     * personales de terceros. Que la pantalla exista no es algo que le tenga que
     * constar a alguien que no la puede abrir.
     *
     * Esto NO es la guarda: la guarda es el chequeo del servidor, que sigue
     * donde estaba. Esto es que el menú diga la verdad.
     */
    ...(puedeVerClientes
      ? [{ label: t("nav.clientes"), href: "/clientes", icon: Users }]
      : []),
  ], esPro, t);

  const analisisItems: NavItemDef[] = conCandadoPro([
    { label: t("nav.metricas"), href: "/metricas", icon: BarChart2 },
    // Sólo para quien maneja al equipo: se esconde por lo mismo que «Clientes».
    ...(puedeRevisar ? [{ label: t("nav.desvios"), href: "/desvios", icon: ClipboardCheck }] : []),
    { label: t("nav.asistente"), href: "/asistente", icon: Sparkles, pro: true },
    // Dentro de la app, con la barra a la vista: `/demo` es la pública, sin sesión.
    { label: t("nav.demo"), href: "/demostracion", icon: Play },
    {
      label: t("nav.agente"),
      href: "/agente",
      icon: Brain,
      disabled: !esAdmin,
      disabledReason: t("nav.agenteBloqueado"),
    },
    /*
     * «Administración» y «Facturación» sólo para admin/owner.
     *
     * `admin/users/page.tsx` y `admin/facturacion/page.tsx` ya se defienden
     * solas con `requireAdmin`: un analista que apretaba el enlace no recibía
     * un 403, volvía en silencio a `/bandeja`. El enlace visible no era un
     * permiso, era un rebote.
     */
    ...(esAdmin
      ? [
          { label: t("nav.admin"), href: "/admin/users", icon: Shield },
          { label: t("nav.facturacion"), href: "/admin/facturacion", icon: Receipt },
        ]
      : []),
    // La cartera y las altas cruzan tenants: las ve el operador, no el
    // asegurador. Se ocultan en vez de deshabilitarse — que la pantalla
    // exista tampoco es algo que le tenga que constar a un cliente.
    ...(isOperator
      ? [
          { label: t("nav.cartera"), href: "/admin/cartera", icon: Briefcase },
          { label: t("nav.altas"), href: "/admin/altas", icon: UserPlus },
        ]
      : []),
  ], esPro, t);

  const CONFIG_HREF = "/configuracion";
  const activo = hrefActivo(
    [...operacionItems, ...analisisItems].map((i) => i.href).concat(CONFIG_HREF),
    pathname,
    searchParams
  );

  const nav = (
    <nav
      id="barra-principal"
      aria-label={t("nav.principal")}
      data-contraida={contraida}
      /*
       * 208 px y no 232: cada píxel de acá se lo saca a la tabla de la bandeja,
       * que a 1400 de ancho llegaba a cortar sus últimas columnas. El rótulo
       * más largo es «Administración», que entra holgado.
       *
       * En el teléfono la barra no ocupa lugar: es un cajón (`fixed`) que se ve
       * sólo abierto, y cerrado es `hidden` para que sus enlaces no entren en el
       * orden de tabulación. `.barra-cajon` (en `globals.css`) le da la posición
       * y el fondo, que en escritorio no lleva: ahí se ve el lienzo.
       */
      className={[
        "barra flex h-full w-[208px] flex-shrink-0 flex-col border-r border-slate-200",
        abierto ? "barra-cajon" : "max-md:hidden",
      ].join(" ")}
    >
      {/* Logo / brand */}
      <div className="barra-logo flex h-16 items-center gap-2.5 px-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-violet-600 text-[11px] font-bold text-white">
          CM
        </div>
        <span className="barra-texto text-[15px] font-semibold tracking-tight text-slate-900">
          ClaimMix
        </span>
        {/*
         * Los dos botones se reparten el lugar: la X sólo en el teléfono y la
         * flecha sólo en escritorio. Van en este orden, antes de los enlaces,
         * porque la trampa de foco cuenta el `display:none` como enfocable: lo
         * que quede escondido no puede ser ni el primero ni el último de la
         * barra, y el último es siempre un enlace a la vista.
         */}
        <button
          type="button"
          onClick={cerrar}
          aria-label={t("nav.cerrarMenu")}
          className="barra-cerrar ml-auto text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          <X size={18} />
        </button>
        <button
          type="button"
          onClick={alternar}
          aria-label={contraida ? t("nav.expandirBarra") : t("nav.contraerBarra")}
          className="barra-contraer ml-auto text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          <ChevronRight size={16} className={contraida ? "" : "rotate-180"} />
        </button>
      </div>

      {/* Navigation links */}
      <div className="flex flex-1 flex-col overflow-y-auto px-2 py-2">
        {/* OPERACIÓN section */}
        <div className="mb-3">
          {/* El `.rotulo` lo pone en mayúscula por CSS, así que la clave
              guarda «Operación» y no «OPERACIÓN»: el diccionario tiene el
              texto, la hoja de estilos la forma. */}
          <p className="rotulo barra-texto mb-1 px-3 text-slate-500">
            {t("nav.operation")}
          </p>
          <div className="space-y-0.5">
            {operacionItems.map((item) => (
              <NavLink key={item.href} {...item} active={item.href === activo} contraida={contraida} />
            ))}
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* ANÁLISIS section */}
        <div className="mb-2">
          <p className="rotulo barra-texto mb-1 px-3 text-slate-500">
            {t("nav.analisis")}
          </p>
          <div className="space-y-0.5">
            {analisisItems.map((item) => (
              <NavLink key={item.href} {...item} active={item.href === activo} contraida={contraida} />
            ))}
          </div>
        </div>

        {/* Settings at bottom */}
        <div className="space-y-0.5 pb-2">
          <NavLink
            href={CONFIG_HREF}
            label={t("nav.configuracion")}
            icon={Settings}
            active={CONFIG_HREF === activo}
            contraida={contraida}
          />
        </div>
      </div>

      {/* El indicador del agente, al pie y fuera del scroll de arriba. */}
      {estadoDelAgente}
    </nav>
  );

  return (
    <>
      {/* El botón del menú, sólo en el teléfono. Los márgenes dejan lugar a la muesca del iPhone. */}
      <button
        type="button"
        onClick={() => setAbierto(true)}
        aria-label={t("nav.abrirMenu")}
        aria-expanded={abierto}
        aria-controls="barra-principal"
        className="barra-menu border border-slate-200 bg-white text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        <Menu size={20} />
      </button>
      {abierto ? (
        <>
          {/* El telón: tocarlo cierra. Escape lo cierra por teclado, así que no necesita ser un botón. */}
          <div aria-hidden="true" onClick={cerrar} className="barra-telon" />
          <Cajon alCerrar={cerrar}>{nav}</Cajon>
        </>
      ) : (
        nav
      )}
    </>
  );
}
