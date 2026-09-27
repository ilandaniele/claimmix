/**
 * Bandeja page — Server Component.
 *
 * AC11: Fetches initial case data, status counts, and scenarios server-side.
 *       Passes to DashboardClient which handles realtime, filters, and interactivity.
 *
 * URL search params supported:
 *   status:  CaseStatus (filter tab)
 *   type:    ClaimType  (filter chip)
 *   q:       string     (búsqueda libre — nombre, póliza o número de caso)
 *   periodo: Periodo    (selector de período — hoy | 7d | 30d | 90d)
 *   page:     number   (pagination)
 *   per_page: number   (page size — must be one of PER_PAGE_OPTIONS)
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRow } from "@/lib/auth/user-row";
import { buildCaseFilters, contarPorEstado, desdeDePeriodo, listCases } from "@/server/cases/list";
import { OPCIONES_DE_ESCENARIO } from "@/server/intake/scenarios";
import { DashboardClient } from "./DashboardClient";
import { PER_PAGE_OPTIONS } from "./per-page";
import { CaseStatusSchema, ChannelSchema, ClaimTypeSchema, PeriodoSchema, SeveritySchema } from "@/lib/schemas/cases";
import type { CaseStatus, ClaimType, Periodo, Severity } from "@/lib/schemas/cases";
import { Card } from "../_components/ui";
import { getT } from "@/lib/i18n";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";

export const VALID_STATUSES: CaseStatus[] = CaseStatusSchema.options;
/*
 * Los tipos que este filtro acepta salen del esquema, no de una lista a mano.
 *
 * Eran cuatro de nueve, y los chips de la pantalla ofrecen ocho. Tocar
 * "Cristales", "Resp. Civil", "Robo de contenido" o "Accidente personal"
 * mandaba el parametro, este whitelist lo descartaba, y el servidor devolvia la
 * pagina SIN filtrar. El cliente despues la recortaba, asi que se veia una
 * lista casi vacia con un paginador prometiendo paginas que no existian.
 *
 * Cuatro filtros que no filtraban, y ninguno fallaba en voz alta.
 */
const VALID_TYPES: ClaimType[] = ClaimTypeSchema.options;
export const VALID_SEVERITIES: Severity[] = SeveritySchema.options;
export const VALID_CHANNELS = ChannelSchema.options;
const VALID_PERIODOS: Periodo[] = PeriodoSchema.options;

/**
 * Normaliza un parámetro multi-valor (`status`, `type`, `severity`,
 * `channel`): junta lo que haya —cero, uno o varios—, descarta lo que no esté
 * en `lista`, y devuelve `undefined` si no queda nada.
 *
 * A propósito distinto de `CaseQuerySchema`: la API rechaza el parámetro
 * ENTERO si trae un valor inválido, acá se descarta sólo ese valor y se sigue
 * — una pantalla no le puede dar 400 a alguien que llegó por un enlace viejo.
 */
function valores<T extends string>(
  raw: string | string[] | undefined,
  lista: readonly T[]
): [T, ...T[]] | undefined {
  if (raw === undefined) return undefined;
  const candidatos = Array.isArray(raw) ? raw : [raw];
  const filtrados = candidatos.filter((v): v is T =>
    (lista as readonly string[]).includes(v)
  );
  return filtrados.length > 0 ? (filtrados as [T, ...T[]]) : undefined;
}

/**
 * El texto de la caja de búsqueda, recortado.
 *
 * Ochenta caracteres alcanza y sobra para un nombre, una póliza o un número
 * de caso; más que eso es un enlace armado a mano, no algo que alguien tipeó
 * en el campo. Vacío, sólo espacios o menos de tres caracteres da
 * `undefined`, igual que `valores()` con el resto de los filtros.
 *
 * El piso de tres espeja el `q.min(3)` de `CaseQuerySchema` (ver
 * src/lib/schemas/cases.ts): con uno o dos caracteres pg_trgm no tiene un
 * grupo de tres para buscar y el planificador descarta el índice, así que
 * `listCases`/`contarPorEstado` recorrerían la tabla entera del inquilino en
 * cada pausa de tipeo. `CampoDeBusqueda` debounca por TIEMPO, no por
 * longitud, así que esos estados intermedios de uno o dos caracteres pasan
 * de verdad.
 */
export function normalizarBusqueda(raw: string | string[] | undefined): string | undefined {
  const valor = Array.isArray(raw) ? raw[0] : raw;
  const recortado = valor?.trim().slice(0, 80);
  return recortado && recortado.length >= 3 ? recortado : undefined;
}

interface BandejaPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function BandejaContent({ searchParams }: BandejaPageProps) {
  const params = await searchParams;
  const t = getT(await getAccountLocale());

  const statusParam = params["status"];
  const typeParam = params["type"];
  const pageParam = params["page"];
  const channelParam = params["channel"];
  const severityParam = params["severity"];
  const isClaimParam = params["is_claim"];
  const para_responder = params["para_responder"] === "true" ? true : undefined;
  const cola = params["cola"] === "mia" ? "mia" : undefined;

  const status = valores(statusParam, VALID_STATUSES);

  const type = valores(typeParam, VALID_TYPES);

  const page =
    typeof pageParam === "string" ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;

  // Page size is user-selectable; only accept the sizes the picker offers so a
  // hand-edited URL can't ask for an unbounded page (listCases caps at 100).
  const perPageParam = params["per_page"];
  const per_page =
    typeof perPageParam === "string" &&
    (PER_PAGE_OPTIONS as readonly number[]).includes(parseInt(perPageParam, 10))
      ? parseInt(perPageParam, 10)
      : 20;

  const channel = valores(channelParam, VALID_CHANNELS);

  const severity = valores(severityParam, VALID_SEVERITIES);

  const is_claim =
    isClaimParam === "true" ? true : isClaimParam === "false" ? false : undefined;

  const q = normalizarBusqueda(params["q"]);
  const periodo = valores(params["periodo"], VALID_PERIODOS)?.[0];
  const desde = desdeDePeriodo(periodo);

  // Resolve the tenant boundary (enTenant filter, backed by RLS).
  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  // Deduplicada con la del layout: ver lib/auth/user-row.ts.
  const userRow = await getUserRow(session.user.id);
  if (!userRow) redirect("/login");
  const tenantId = userRow.tenant_id;

  // Fetch cases matching the current filter.
  /*
   * La lista y los contadores salen JUNTOS, no uno después del otro.
   *
   * Estaban en serie: `await listCases(...)` y recién después el `await` de
   * los contadores. Las dos consultas sólo necesitan `tenantId`; ninguna
   * depende de la otra. En serie, la página pagaba un viaje entero al pooler
   * de más antes de pintar — y con quinientos casos lo que domina el tiempo
   * es la ida y vuelta, no la consulta. Es la regla `async-parallel` de las
   * guías de rendimiento de Vercel: operaciones independientes van en un
   * `Promise.all`.
   *
   * ── Los catorce contadores en un solo viaje ─────────────────────────────
   *
   * Eran catorce `countRows` en un `Promise.all`: uno por estado más el total.
   * Estar en paralelo no los junta — cada `enTenant` abre su propio `batch()`
   * contra Neon con su `set_config` adelante, así que la pantalla principal
   * arrancaba con catorce transacciones HTTP en vez de una.
   *
   * No era lento por la base: hay índice `(tenant_id, status)` y cada COUNT era
   * un scan barato. Lo que se ahorra son trece viajes y trece transacciones.
   *
   * `count(*)::int` escrito a mano y no `db.$count`: eso último devuelve algo
   * que se puede esperar pero que `batch()` no puede armar, y rompió estos
   * mismos contadores en producción. Ver src/lib/db/helpers.ts.
   */
  const [initialData, porEstado] = await Promise.all([
    listCases({ tenantId }, {
      status,
      type,
      q,
      desde,
      page,
      per_page,
      sort: "created_at",
      order: "desc",
      // Email-intake filters (AC18)
      channel,
      severity,
      is_claim,
      para_responder,
      cola,
    }, userRow.id),
    // Contadores de las pestañas: sólo búsqueda y período los mueven, nunca
    // los chips de estado/tipo/severidad — ver `consultaPorEstado`.
    contarPorEstado({ tenantId }, buildCaseFilters({ q, desde })),
  ]);

  /*
   * El total suma TODAS las filas que devuelve el grupo, no sólo las de los
   * estados de la lista de arriba.
   *
   * Hoy da lo mismo: la base tiene `cases_status_check` con exactamente estos
   * trece valores, así que no puede haber una fila fuera. Se suma todo igual
   * porque `VALID_STATUSES` sale de `CaseStatusSchema`, no de esa columna, y el
   * día que el CHECK sume un estado y el schema no, la tarjeta «Total casos»
   * bajaría sin error visible. Sumar lo que vuelve no depende de que las dos
   * listas estén sincronizadas; sumar lo mapeado sí.
   */
  const cuenta = new Map(porEstado.map((r) => [r.status, r.n]));
  const totalCount = porEstado.reduce((acc, r) => acc + r.n, 0);

  const allStatusCounts: { status: CaseStatus | "todos"; count: number }[] = [
    { status: "todos", count: totalCount },
    // Se recorre VALID_STATUSES y no el resultado: un estado sin casos no
    // vuelve del GROUP BY, y su pestaña tiene que mostrar 0, no desaparecer.
    ...VALID_STATUSES.map((s) => ({ status: s, count: cuenta.get(s) ?? 0 })),
  ];


  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-5 pt-1">
        {/*
         * El título de la pantalla, que antes no estaba.
         *
         * La barra de arriba sólo tiene los controles de la persona, así que la
         * bandeja empezaba directamente en los números, sin decir dónde estás.
         *
         * Sale del diccionario y no escrito a mano: puesto a mano decía
         * «Bandeja» en castellano incluso con la interfaz en inglés, y encima
         * `DashboardClient` repetía este mismo título adentro de la tarjeta.
         */}
        <h1 className="text-balance text-[26px] font-semibold tracking-tight text-slate-900">
          {para_responder
            ? t("bandeja.paraResponder")
            : cola
              ? t("nav.miCola")
              : t("bandeja.title")}
        </h1>
        <p className="mt-1 text-[13px] text-slate-500">{t("bandeja.subtitle")}</p>

        {/*
         * Acá vivían cuatro baldosas —Total, Escalados, Esperando, Listos— y no
         * están más.
         *
         * No es sólo lugar. Los mismos cuatro números viven ahora en los chips
         * de estado del panel de filtros, y ahí además SIRVEN: se aprieta el que
         * dice 43 y la lista queda en esos 43. Una baldosa informa y hay que ir
         * a buscar el control en otro lado; un filtro con su contador hace las
         * dos cosas.
         *
         * Y lo que se saca de encima es medio metro de pantalla en la vista que
         * se mira ocho horas por día: antes había que bajar para ver la quinta
         * fila de la lista.
         */}
      </div>

      {/*
        * La lista, dentro de la misma tarjeta que todo lo demás.
        *
        * `pb-8` y no `pb-6`: la pantalla mide exactamente el alto de la
        * ventana, así que lo que sobre acá abajo es TODO el aire que hay entre
        * el paginador y el borde. Con 24 px la tarjeta se leía pegada al filo.
        */}
      <div className="flex-1 overflow-hidden px-6 pb-8">
        <Card className="flex h-full flex-col overflow-hidden">
          <DashboardClient
            initialData={initialData}
            scenarios={OPCIONES_DE_ESCENARIO}
            allStatusCounts={allStatusCounts}
          />
        </Card>
      </div>
    </div>
  );
}

/**
 * El esqueleto de carga, con la forma de lo que va a aparecer.
 *
 * Tenía la forma VIEJA de la pantalla —tres franjas con borde duro, sin las
 * baldosas de indicador y sin tarjeta— así que al terminar de cargar el diseño
 * saltaba a otra cosa. Un esqueleto que no coincide con su destino es peor que
 * no tener esqueleto: promete un layout y entrega otro.
 */
/*
 * El esqueleto se mudo a `loading.tsx` y con el se fue el `<Suspense>` de aca.
 *
 * No es lo mismo aunque se vea igual: un `<Suspense>` adentro de page.tsx NO
 * crea una frontera de carga para Next. Y sin frontera, una ruta dinamica
 * —todas las de `(app)` lo son, porque el layout lee cookies— no se precarga:
 * el `<Link>` de la barra no adelanta nada y el clic deja la pantalla vieja
 * congelada hasta que el servidor termina de renderizar entera.
 *
 * Con `loading.tsx`, Next precarga hasta esa frontera y pinta el esqueleto en
 * el acto.
 */
export default function BandejaPage(props: BandejaPageProps) {
  return <BandejaContent {...props} />;
}
