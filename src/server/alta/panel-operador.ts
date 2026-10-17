/**
 * Lo que el operador lee y escribe sobre las altas automáticas.
 *
 * Es el ÚNICO archivo de `src/` que escribe `tenants`, `whatsapp_numeros` y
 * `whatsapp_wabas` con el rol dueño (lo vigila `pnpm arquitectura`): la app, con
 * `claimmix_app`, no tiene permiso sobre ellas desde la 0048 y la 0051, y el rol
 * dueño no tiene RLS. Cruzar
 * inquilinos es justamente el trabajo de esta pantalla, así que acá no hay
 * `enTenant`; en cambio cada acción hace dos cosas que el `enTenant` no daría:
 *
 *   - sólo toca inquilinos del alta automática (`autoalta`): un id armado a mano
 *     contra la plataforma o contra la casa no hace nada;
 *   - es UNA sentencia con el asiento de auditoría adentro (CTE), así que no
 *     hay cambio sin asiento ni asiento sin cambio. El `actor_id` es quien opera.
 *
 * Nada se borra. «Baja» es un estado: la fila queda con su `phone_number_id`,
 * porque de ella dependen la cuarentena de 30 días, la marca de repetido de 90
 * y que el número de la plataforma siga cortado. Lo único que sí se borra es el
 * secreto: toda baja deja `token_cifrado` y `pin_cifrado` en NULL, venga del
 * cliente, de Meta, del operador o del sistema (`bajaDeWaba` es la única sentencia
 * que lo hace).
 *
 * La WABA propia del cliente (0051) se escribe acá con las mismas reglas de
 * transición que la función `claimmix_waba_propia`, que sólo deja pasar a un
 * dueño o admin del espacio: el operador no lo es, así que `almacenDelDueno` repite
 * sus pasos con el operador como autor del asiento.
 *
 * Todo tolera que la 0048 o la 0051 todavía no estén aplicadas (42P01 / 42703 /
 * 42883): la lectura avisa que falta y las acciones devuelven `migracion_pendiente`.
 *
 * Con `BASE_POR_CLIENTE` el rol dueño apunta a control, que es donde se escribe. Cada
 * cambio que sale bien se espeja a la base del cliente (el espejo lleva el número y
 * `billing_status`): si la copia no entra la acción devuelve `espejo_pendiente`, que
 * no es un fallo —el cambio ya está— y el barrido la levanta.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { after } from "next/server.js";

import { AuditEvent } from "@/lib/audit/log";
import { PLAN_CATALOG, isPlan, type Plan } from "@/lib/billing/plans";
import { db } from "@/lib/db";
import { ID_DE_META } from "@/lib/meta-ids";
import { conteoDe, filasDe } from "@/lib/db/filas";
import { topeGlobalDelDia } from "@/server/alta/crear-inquilino";
import { continuarWaba, soltarEnMeta, type Almacen, type FilaDeWaba, type GuardadoDeWaba } from "@/server/alta/waba-propia";
import { FALLAS_DE_WABA, type FallaDeWaba, type ResultadoDeApp } from "@/server/alta/waba-resultados";
import { esNumeroDeOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";
import { idDeLaPlataforma, inquilinoDeLaPlataforma, wabaDeLaPlataforma } from "@/server/whatsapp/numeros";
import { aadDelPin, aadDelSecreto, aadDelToken, abrirSobre, pruebaDelSecreto } from "@/server/whatsapp/sobres-del-cliente";
import { verificarEnMeta, type MotivoDeMeta } from "@/server/whatsapp/verificar-en-meta";

/** Quién opera y desde dónde: lo que queda en cada asiento. */
export interface Operador {
  userId: string;
  ip: string | null;
}

export type ResultadoDeAccion = "ok" | "no_aplica" | "migracion_pendiente" | "espejo_pendiente";

export type ResultadoDeConexion =
  | ResultadoDeAccion
  | MotivoDeMeta
  | "datos_invalidos"
  | "id_de_la_plataforma"
  | "de_otro_ambiente"
  | "en_cuarentena"
  | "numero_duplicado"
  | "id_ocupado";

/** Lo que la pantalla puede mostrar tras una acción; es la lista cerrada que acepta `?r=`. */
export const RESULTADOS_DEL_PANEL = [
  "ok",
  "no_aplica",
  "migracion_pendiente",
  "espejo_pendiente",
  "datos_invalidos",
  "no_confirmado",
  "falla",
  "id_de_la_plataforma",
  "de_otro_ambiente",
  "en_cuarentena",
  "numero_duplicado",
  "id_ocupado",
  "sin_credencial",
  "waba_distinta",
  "meta_no_responde",
  "id_inexistente",
  "numero_distinto",
  "fuera_de_la_waba",
  "waba_reintentada",
  "waba_desvinculada",
  "waba_sin_token",
  "legales_despublicadas",
] as const;

export type ResultadoDelPanel = (typeof RESULTADOS_DEL_PANEL)[number];

export function resultadoDelPanel(crudo: unknown): ResultadoDelPanel | null {
  return (RESULTADOS_DEL_PANEL as readonly unknown[]).includes(crudo) ? (crudo as ResultadoDelPanel) : null;
}

/** La cuarentena de un `phone_number_id` dado de baja en otro espacio. */
const DIAS_DE_CUARENTENA = 30;
/** Cuánto se acuerda la lista de un número dado de baja en otro espacio. */
const DIAS_DE_HISTORIAL = 90;
/** Tope de la prueba: lo mismo que `ALTA_PRUEBA_DIAS` admite. */
export const DIAS_MAXIMOS_DE_PRUEBA = 90;
/** Filas de la pantalla; con el tope de 24 h son semanas de altas. */
const FILAS_MAXIMAS = 200;
/** Ventana de la demora del alta en el panel. */
const DIAS_DE_DEMORA = 30;

/** Las columnas y las tablas que agregan la 0048, la 0050 (`tenant_bases`, para la demora) y la 0051, y sus funciones: sin ellas el panel no tiene de dónde leer. */
const FALTA_LA_0048 = new Set(["42P01", "42703", "42883"]);

// sin-inquilino: El panel del operador cruza inquilinos a propósito: lista las
// altas de todos y cada acción escribe sobre el inquilino que elige quien opera.
const ejecutar = (consulta: SQL) => db.execute(consulta);

/** La fila de número es de un espacio del alta automática; `w` es la fila de `whatsapp_numeros`. */
const DEL_ALTA = sql`exists (select 1 from public.tenants x where x.id = w.tenant_id and x.autoalta)`;

/** Un número con token propio es de una WABA propia (el camino de la plataforma no guarda uno): lo conecta el paso `conectar`, no un id tipeado, que le dejaría ese token a otra WABA. */
const SIN_TOKEN_PROPIO = sql`w.token_cifrado is null`;

const json = (valor: object): SQL => sql`${JSON.stringify(valor)}::jsonb`;

/** Los estados de `whatsapp_wabas` de los que todavía se puede salir con una baja: todos menos `revocada`. `armando` es de la app propia, que ya guardó su secreto y su ruta. */
const VIVAS = ["armando", "cancelada", "vinculada", "suscripta", "falta_codigo", "falta_pin", "conectada", "falla"] as const;
const enLista = (xs: readonly string[]): SQL =>
  sql.join(
    xs.map((x) => sql`${x}::text`),
    sql`, `
  );
const ESTADOS_VIVOS = enLista(VIVAS);
/**
 * Lo que toda baja deja en la fila de la WABA: sin el PIN ni, en la app propia, el secreto y la ruta
 * del webhook (que sin fila viva deja de contestar). `app_id`, `datos_app_en` y `slug_legal` quedan:
 * el historial, y la app del cliente sigue apuntando a sus páginas legales.
 */
const revocadaCon = (falla: SQL): SQL =>
  sql`estado = 'revocada', falla = ${falla}, pin_cifrado = null, app_secreto_cifrado = null, ruta_webhook = null, webhook_app_verificado_en = null, actualizado_en = now()`;
/** Quien se va por su cuenta, o a quien el operador desconecta, no tiene una falla que contarle: la pantalla vuelve a la lista de antes de empezar. */
const REVOCADA = revocadaCon(sql`null`);
/** Meta sacó la app: el token ya no sirve y la pantalla se lo dice (`token_vencido`) en vez de ofrecer empezar de cero sin explicar. */
const REVOCADA_POR_META = revocadaCon(sql`'token_vencido'::text`);
/** El espacio es del alta automática y puede seguir conectando: en prueba vigente o activo. `x` es la fila de `tenants`. */
const PUEDE_CONECTAR = sql`x.autoalta and x.billing_status in ('trial', 'active')
    and (x.billing_status <> 'trial' or x.trial_ends_at is null or x.trial_ends_at > now())`;
/** Lo mismo desde la fila de `whatsapp_wabas` (`b`). */
const ESPACIO_ACTIVO = sql`exists (select 1 from public.tenants x where x.id = b.tenant_id and ${PUEDE_CONECTAR})`;

/** Quién hizo el cambio cuando no es el operador: Meta (un aviso firmado) o el sistema (la tarea programada). */
export type Actor = Operador | "meta" | "sistema";

/**
 * El asiento de auditoría de una acción, para colgar de su CTE. La acción tiene
 * que llamar `u` a lo que modificó, con `id` y `tenant_id`: sin filas en `u`
 * tampoco hay asiento. `de` es de dónde salen esas filas; `u` por omisión. Meta y
 * el sistema no son una persona: el asiento queda sin `actor_id` ni IP.
 */
function asiento(
  actor: Actor,
  evento: string,
  objetivo: "tenant" | "whatsapp_numero" | "whatsapp_waba",
  payload: SQL,
  de: SQL = sql`u`
): SQL {
  const quien = typeof actor === "string" ? { userId: null, ip: null } : actor;
  return sql`insert into public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload, ip)
    select u.tenant_id, ${quien.userId}::uuid, ${evento}::text, ${objetivo}::text, u.id::text, ${payload}, ${quien.ip}::inet
    from ${de}`;
}

/** El final de una acción: cuántas filas cambió `u` y de qué inquilino, para espejarlo. */
const CUENTA_DE_U = sql`select count(*)::int as n, min(u.tenant_id::text) as tenant_id from u`;

/** El cambio ya está en control: «ok» si la copia del cliente también entró, y «espejo_pendiente» si queda para el barrido. */
async function espejado(tenantId: unknown): Promise<ResultadoDeAccion> {
  if (typeof tenantId !== "string") return "ok";
  return (await espejarSinFallar(tenantId)) ? "ok" : "espejo_pendiente";
}

/**
 * Corre una acción que devuelve cuántas filas cambió: ninguna es `no_aplica`, no un
 * error. `conEspejo` es falso cuando lo que cambió es sólo de control (la fila de la
 * WABA), que la base del cliente no copia. `sinLaTabla` es la misma acción sin lo que
 * toca la tabla de la WABA propia: si falta (sin la 0051), corre esa en su lugar.
 */
async function aplicar(consulta: SQL, conEspejo = true, sinLaTabla?: SQL): Promise<ResultadoDeAccion> {
  try {
    const resultado = await ejecutar(consulta);
    if (conteoDe(resultado) === 0) return "no_aplica";
    return conEspejo ? await espejado(filasDe<Cruda>(resultado)[0]?.tenant_id) : "ok";
  } catch (e) {
    if (!FALTA_LA_0048.has(codigoPg(e) ?? "")) throw e;
    return sinLaTabla ? aplicar(sinLaTabla, conEspejo) : "migracion_pendiente";
  }
}

// ── La lista ────────────────────────────────────────────────────────────────

export interface OtroTitular {
  espacio: string;
  contactEmail: string | null;
  estado: string;
  desde: string | null;
}

/** La fila de `whatsapp_wabas` de un espacio: cómo va su WABA propia. Sin ella, el espacio usa la de la plataforma. */
export interface WabaDeAlta {
  estado: string;
  falla: string | null;
  pasoCancelado: string | null;
  wabaId: string | null;
  businessId: string | null;
  nombreEstado: string | null;
  plantillaEnviadaEn: string | null;
  actualizadoEn: string | null;
  /** Por dónde se conectó: Embedded Signup, o la app de Meta del propio cliente. */
  origen: "embedded_signup" | "app_propia";
  /** Sólo de la app propia: el id de su app de Meta, y los hitos del alta (null hasta que ocurren). */
  appId: string | null;
  webhookVerificadoEn: string | null;
  datosAppEn: string | null;
  primerMensajeEn: string | null;
  primeraRespuestaEn: string | null;
  /** Lo que Graph dice del envío (`can_send_message`), tal cual lo guardó la revisión de salud. */
  puedeEnviar: string | null;
  recordatorioEn: string | null;
  /** Hay un `slug_legal`: las páginas legales del cliente están publicadas. El slug no sale del servidor. */
  legalesPublicadas: boolean;
}

export interface FilaDeAlta {
  tenantId: string;
  nombre: string;
  contactEmail: string | null;
  creadoEn: string | null;
  plan: string;
  estadoDeFacturacion: string;
  pruebaHasta: string | null;
  activadoEn: string | null;
  numero: {
    id: string;
    e164: string;
    estado: string;
    phoneNumberId: string | null;
    wabaId: string | null;
  } | null;
  /** Su WABA propia (Embedded Signup); null si nunca abrió el popup. */
  waba: WabaDeAlta | null;
  /** Pidió un número que otro espacio ya tenía: se creó sin fila de número. */
  numeroEnRevision: boolean;
  /** Los otros espacios con el mismo número (en cualquier forma de escribir el 9 argentino): vivos, o dados de baja hace menos de 90 días. */
  repetidoEn: OtroTitular[];
}

export interface PanelDeAltas {
  /** La 0048 no está aplicada: no hay altas que leer. */
  migracionPendiente: boolean;
  altas: FilaDeAlta[];
  creadas24h: number;
  tope: number;
  /** Lo que tardó en quedar lista la base de las altas de los últimos 30 días, en segundos (de `creada_at` a `lista_at` en tenant_bases); null sin ninguna lista. */
  demoraDeAlta: { mediana: number | null; p95: number | null };
}

const SIN_DEMORA: PanelDeAltas["demoraDeAlta"] = { mediana: null, p95: null };

type Cruda = Record<string, unknown>;

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const segundos = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

/** Una fecha de la base, venga como texto o como Date, en texto ISO. */
function fecha(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return texto(v);
}

/** El jsonb, venga ya leído o como texto. */
function lista(v: unknown): Cruda[] {
  const x = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(x) ? (x as Cruda[]) : [];
}

function aFila(f: Cruda): FilaDeAlta {
  const numeroId = texto(f.numero_id);
  return {
    tenantId: String(f.tenant_id),
    nombre: String(f.nombre ?? ""),
    contactEmail: texto(f.contact_email),
    creadoEn: fecha(f.created_at),
    plan: String(f.plan ?? ""),
    estadoDeFacturacion: String(f.billing_status ?? ""),
    pruebaHasta: fecha(f.trial_ends_at),
    activadoEn: fecha(f.activated_at),
    numero: numeroId
      ? {
          id: numeroId,
          e164: String(f.numero_e164 ?? ""),
          estado: String(f.numero_estado ?? ""),
          phoneNumberId: texto(f.phone_number_id),
          wabaId: texto(f.waba_id),
        }
      : null,
    waba: texto(f.waba_estado)
      ? {
          estado: String(f.waba_estado),
          falla: texto(f.waba_falla),
          pasoCancelado: texto(f.waba_paso_cancelado),
          wabaId: texto(f.waba_propia_id),
          businessId: texto(f.waba_business_id),
          nombreEstado: texto(f.waba_nombre_estado),
          plantillaEnviadaEn: fecha(f.waba_plantilla_enviada_en),
          actualizadoEn: fecha(f.waba_actualizado_en),
          origen: f.waba_origen === "app_propia" ? "app_propia" : "embedded_signup",
          appId: texto(f.waba_app_id),
          webhookVerificadoEn: fecha(f.waba_webhook_verificado_en),
          datosAppEn: fecha(f.waba_datos_app_en),
          primerMensajeEn: fecha(f.waba_primer_mensaje_en),
          primeraRespuestaEn: fecha(f.waba_primera_respuesta_en),
          puedeEnviar: texto(f.waba_puede_enviar),
          recordatorioEn: fecha(f.waba_recordatorio_en),
          legalesPublicadas: f.waba_legales === true,
        }
      : null,
    numeroEnRevision: f.numero_en_revision === true,
    repetidoEn: lista(f.repetido_en).map((o) => ({
      espacio: String(o.espacio ?? ""),
      contactEmail: texto(o.contact_email),
      estado: String(o.estado ?? ""),
      desde: fecha(o.desde),
    })),
  };
}

/**
 * Las altas automáticas, más nuevas primero, en UNA consulta: el inquilino, su
 * número, su WABA propia si la tiene, la marca de «número en revisión» (del asiento de alta), los otros
 * titulares del mismo número, cuántas altas van en 24 h y cuánto tardó en quedar
 * lista la base de las de los últimos 30 días (mediana y p95, de `tenant_bases`).
 * El 9 argentino se ignora al comparar, igual que `mismoNumero`: «+549…» y «+54…» son el mismo.
 *
 * El conteo de 24 h y la demora van aparte de la lista para que una lista vacía igual los traiga.
 */
export async function listarAltas(): Promise<PanelDeAltas> {
  const tope = topeGlobalDelDia();
  try {
    return await altasDe(true, tope);
  } catch (e) {
    if (!FALTA_LA_0048.has(codigoPg(e) ?? "")) throw e;
  }
  // Sin la 0051 falta sólo la tabla de la WABA propia: el panel sigue con lo de antes y ningún espacio la tiene. Si también falta la 0048 o la 0050, no hay panel.
  try {
    return await altasDe(false, tope);
  } catch (e) {
    if (!FALTA_LA_0048.has(codigoPg(e) ?? "")) throw e;
    return { migracionPendiente: true, altas: [], creadas24h: 0, tope, demoraDeAlta: SIN_DEMORA };
  }
}

async function altasDe(conWabas: boolean, tope: PanelDeAltas["tope"]): Promise<PanelDeAltas> {
  const filas = filasDe<Cruda>(
    await ejecutar(sql`
      select c.creadas_24h, d.demora_mediana_s, d.demora_p95_s, l.*
      from (
        select count(*)::int as creadas_24h
        from public.tenants
        where autoalta and created_at > now() - interval '24 hours'
      ) c
      cross join (
        select
          round(percentile_cont(0.5) within group (order by extract(epoch from tb.lista_at - tb.creada_at)::float8))::int as demora_mediana_s,
          round(percentile_cont(0.95) within group (order by extract(epoch from tb.lista_at - tb.creada_at)::float8))::int as demora_p95_s
        from public.tenant_bases tb
        join public.tenants x on x.id = tb.tenant_id and x.autoalta
        where tb.lista_at > now() - make_interval(days => ${DIAS_DE_DEMORA}::int)
      ) d
      left join (
        select
          t.id as tenant_id, t.name as nombre, t.contact_email, t.created_at, t.plan, t.billing_status,
          t.trial_ends_at, t.activated_at,
          n.id as numero_id, n.numero_e164, n.estado as numero_estado, n.phone_number_id, n.waba_id,
          ${
            conWabas
              ? sql`b.estado as waba_estado, b.falla as waba_falla, b.paso_cancelado as waba_paso_cancelado,
          b.waba_id as waba_propia_id, b.business_id as waba_business_id, b.nombre_estado as waba_nombre_estado,
          b.plantilla_enviada_en as waba_plantilla_enviada_en, b.actualizado_en as waba_actualizado_en,
          b.origen as waba_origen, b.app_id as waba_app_id, b.webhook_app_verificado_en as waba_webhook_verificado_en,
          b.datos_app_en as waba_datos_app_en, b.primer_mensaje_en as waba_primer_mensaje_en,
          b.primera_respuesta_en as waba_primera_respuesta_en, b.puede_enviar as waba_puede_enviar,
          b.recordatorio_en as waba_recordatorio_en, (b.slug_legal is not null) as waba_legales`
              : sql`null::text as waba_estado`
          },
          exists (
            select 1 from public.audit_log a
            where a.tenant_id = t.id and a.event_type = ${AuditEvent.TENANT_CREATED}::text
              and a.payload @> '{"numero_en_revision": true}'::jsonb
          ) as numero_en_revision,
          case when n.id is null then '[]'::jsonb else coalesce((
            select jsonb_agg(
              jsonb_build_object('espacio', ot.name, 'contact_email', ot.contact_email, 'estado', o.estado, 'desde', o.creado_en)
              order by o.creado_en desc
            )
            from public.whatsapp_numeros o
            join public.tenants ot on ot.id = o.tenant_id
            where o.tenant_id <> t.id
              and regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(n.numero_e164, '^[+]549', '+54')
              and (o.estado <> 'baja' or o.actualizado_en > now() - make_interval(days => ${DIAS_DE_HISTORIAL}::int))
          ), '[]'::jsonb) end as repetido_en
        from public.tenants t
        left join lateral (
          select w.id, w.numero_e164, w.estado, w.phone_number_id, w.waba_id
          from public.whatsapp_numeros w
          where w.tenant_id = t.id
          order by (w.estado = 'baja'), w.creado_en desc
          limit 1
        ) n on true
        ${conWabas ? sql`left join public.whatsapp_wabas b on b.tenant_id = t.id` : sql``}
        where t.autoalta
        order by t.created_at desc
        limit ${FILAS_MAXIMAS}::int
      ) l on true
      order by l.created_at desc nulls last
    `)
  );
  return {
    migracionPendiente: false,
    altas: filas.filter((f) => f.tenant_id != null).map(aFila),
    creadas24h: Number(filas[0]?.creadas_24h ?? 0) || 0,
    tope,
    demoraDeAlta: { mediana: segundos(filas[0]?.demora_mediana_s), p95: segundos(filas[0]?.demora_p95_s) },
  };
}

// ── El número ───────────────────────────────────────────────────────────────

interface NumeroPedido {
  tenantId: string;
  numeroE164: string;
}

/** El número que pidió un inquilino y todavía no se conectó; null si no existe o ya no está en `pedido`. */
async function leerNumeroPedido(numeroId: string): Promise<NumeroPedido | null> {
  const fila = filasDe<Cruda>(
    await ejecutar(sql`
      select w.tenant_id, w.numero_e164
      from public.whatsapp_numeros w
      where w.id = ${numeroId}::uuid and w.estado = 'pedido' and ${DEL_ALTA} and ${SIN_TOKEN_PROPIO}
    `)
  )[0];
  return fila ? { tenantId: String(fila.tenant_id), numeroE164: String(fila.numero_e164) } : null;
}

/** ¿Es el inquilino de la plataforma, el del número del .env? Los ids de inquilino se comparan sin mayúsculas. */
function esLaPlataforma(tenantId: string): boolean {
  const plataforma = inquilinoDeLaPlataforma();
  return plataforma !== null && plataforma.toLowerCase() === tenantId.toLowerCase();
}

/**
 * Conecta el número que un inquilino pidió, con el `phone_number_id` y la WABA
 * que el operador copió del panel de Meta.
 *
 * Antes de escribir nada, Graph tiene que confirmar que lo tipeado es ese
 * número (`verificarEnMeta`). Se rechaza si:
 *   - el id es el de la plataforma y el inquilino no lo es: sería mandar la
 *     bandeja de la casa a otro espacio;
 *   - el id o el número están en `NUMEROS_DE_DEV`: son del otro ambiente, que
 *     comparte la app de Meta, y conectarlos acá le sacaría el webhook;
 *   - el id tuvo una fila dada de baja en OTRO inquilino hace menos de 30 días
 *     (cuarentena: se dio de baja por algo);
 *   - el pedido es de una WABA propia (trae su token): se termina con el paso
 *     `conectar`, no a mano;
 *   - otro inquilino ya tiene ese número vivo;
 *   - el índice único dice que el id ya es de otro (23505), aunque dos
 *     operadores lo carguen a la vez.
 *
 * La cuarentena y el repetido se miran DENTRO de la sentencia que escribe, no
 * antes: así no hay un hueco entre mirar y escribir.
 */
export async function conectarNumero(
  pedido: { numeroId: string; phoneNumberId: string; wabaId: string; pruebaDeControl: true },
  op: Operador
): Promise<ResultadoDeConexion> {
  const { numeroId, phoneNumberId, wabaId } = pedido;
  if (!ID_DE_META.test(phoneNumberId) || !ID_DE_META.test(wabaId)) return "datos_invalidos";

  let fila: NumeroPedido | null;
  try {
    fila = await leerNumeroPedido(numeroId);
  } catch (e) {
    if (FALTA_LA_0048.has(codigoPg(e) ?? "")) return "migracion_pendiente";
    throw e;
  }
  if (!fila) return "no_aplica";

  if (phoneNumberId === idDeLaPlataforma() && !esLaPlataforma(fila.tenantId)) return "id_de_la_plataforma";
  if (esNumeroDeOtroAmbiente(phoneNumberId, fila.numeroE164)) return "de_otro_ambiente";

  const enMeta = await verificarEnMeta({ phoneNumberId, wabaId, numeroE164: fila.numeroE164 });
  if (!enMeta.ok) return enMeta.motivo;

  const payload = json({ phone_number_id: phoneNumberId, waba_id: wabaId, prueba_de_control: true });
  try {
    const resultado = filasDe<{ resultado?: string }>(
      await ejecutar(sql`
        with fila as (
          select w.id, w.tenant_id, w.numero_e164
          from public.whatsapp_numeros w
          where w.id = ${numeroId}::uuid and w.estado = 'pedido' and ${DEL_ALTA} and ${SIN_TOKEN_PROPIO}
        ), otros as (
          select
            exists (
              select 1 from public.whatsapp_numeros q, fila f
              where q.phone_number_id = ${phoneNumberId}::text and q.estado = 'baja' and q.tenant_id <> f.tenant_id
                and q.actualizado_en > now() - make_interval(days => ${DIAS_DE_CUARENTENA}::int)
            ) as cuarentena,
            exists (
              select 1 from public.whatsapp_numeros q, fila f
              where q.tenant_id <> f.tenant_id and q.estado <> 'baja'
                and regexp_replace(q.numero_e164, '^[+]549', '+54') = regexp_replace(f.numero_e164, '^[+]549', '+54')
            ) as duplicado
        ), u as (
          update public.whatsapp_numeros w
          set estado = 'conectado', phone_number_id = ${phoneNumberId}::text, waba_id = ${wabaId}::text,
              conectado_en = now(), actualizado_en = now()
          from fila f, otros o
          where w.id = f.id and not o.cuarentena and not o.duplicado
          returning w.id, w.tenant_id
        ), a as (
          ${asiento(op, AuditEvent.WHATSAPP_NUMERO_CONECTADO, "whatsapp_numero", payload)}
        )
        select case
          when exists (select 1 from u) then 'ok'
          when not exists (select 1 from fila) then 'no_aplica'
          when (select cuarentena from otros) then 'en_cuarentena'
          else 'numero_duplicado'
        end as resultado
      `)
    )[0]?.resultado;
    if (resultado === "ok") return await espejado(fila.tenantId);
    return resultado === "en_cuarentena" || resultado === "numero_duplicado" ? resultado : "no_aplica";
  } catch (e) {
    const codigo = codigoPg(e) ?? "";
    if (codigo === "23505") return "id_ocupado";
    if (FALTA_LA_0048.has(codigo)) return "migracion_pendiente";
    throw e;
  }
}

/** Corta el número: deja de recibir y de mandar, pero la fila y su id quedan. */
export function suspenderNumero(numeroId: string, op: Operador): Promise<ResultadoDeAccion> {
  return aplicar(sql`
    with u as (
      update public.whatsapp_numeros w set estado = 'suspendido', actualizado_en = now()
      where w.id = ${numeroId}::uuid and w.estado = 'conectado' and ${DEL_ALTA}
      returning w.id, w.tenant_id
    ), a as (
      ${asiento(op, AuditEvent.WHATSAPP_NUMERO_SUSPENDIDO, "whatsapp_numero", json({ estado: "suspendido" }))}
    )
    ${CUENTA_DE_U}
  `);
}

/** Vuelve a conectar un número suspendido, con los ids que ya tenía. Un pedido sin ids se conecta, no se reactiva. */
export function reactivarNumero(numeroId: string, op: Operador): Promise<ResultadoDeAccion> {
  return aplicar(sql`
    with u as (
      update public.whatsapp_numeros w set estado = 'conectado', actualizado_en = now()
      where w.id = ${numeroId}::uuid and w.estado = 'suspendido'
        and w.phone_number_id is not null and w.waba_id is not null and ${DEL_ALTA}
      returning w.id, w.tenant_id
    ), a as (
      ${asiento(op, AuditEvent.WHATSAPP_NUMERO_CONECTADO, "whatsapp_numero", json({ via: "reactivar" }))}
    )
    ${CUENTA_DE_U}
  `);
}

/** Da de baja el número. No borra: la fila conserva el id, y de él dependen la cuarentena y el historial. Si era el de una WABA propia, la revoca. */
export function darDeBajaNumero(numeroId: string, op: Operador): Promise<ResultadoDeAccion> {
  const baja = (conWaba: boolean) => sql`
    with u as (
      update public.whatsapp_numeros w set estado = 'baja', token_cifrado = null, actualizado_en = now()
      where w.id = ${numeroId}::uuid and w.estado <> 'baja' and ${DEL_ALTA}
      returning w.id, w.tenant_id, w.waba_id
    ), ${
      conWaba
        ? sql`r as (
      update public.whatsapp_wabas b set ${REVOCADA}
      from u
      where b.tenant_id = u.tenant_id and b.waba_id = u.waba_id and b.waba_id is distinct from ${wabaDeLaPlataforma()}::text
        and b.estado in (${ESTADOS_VIVOS})
      returning b.tenant_id
    ), `
        : sql``
    }a as (
      ${asiento(op, AuditEvent.WHATSAPP_NUMERO_BAJA, "whatsapp_numero", json({ estado: "baja" }))}
    )
    ${CUENTA_DE_U}
  `;
  // Sin la 0051 no hay WABA propia que revocar: el número igual se da de baja.
  return aplicar(baja(true), true, baja(false));
}

// ── La WABA propia ──────────────────────────────────────────────────────────

const NOMBRE_ESTADO = /^[A-Z_]{1,30}$/;
const ESTADOS_QUE_SE_ESCRIBEN: ReadonlySet<string> = new Set(["suscripta", "falta_codigo", "falta_pin", "falla", "conectada"]);

/** De dónde se puede llegar a cada estado: las mismas reglas que el paso `estado` de la función de la 0051. */
function desdeDe(nuevo: string): readonly string[] {
  if (nuevo === "conectada") return ["conectada"];
  if (nuevo === "falla") return ["cancelada", "vinculada", "suscripta", "falta_codigo", "falta_pin", "falla"];
  return ["vinculada", "suscripta", "falta_codigo", "falta_pin", "falla"];
}

/**
 * Paso `estado` del operador. No escribe el PIN (es del cliente) ni asienta nada: igual
 * que en la función, es un hecho de lo que Graph fue diciendo, no una decisión de alguien.
 */
async function guardarEstado(tenantId: string, datos: Record<string, unknown>): Promise<GuardadoDeWaba> {
  const nuevo = datos.estado;
  const falla = datos.falla ?? null;
  const nombre = datos.nombre_estado ?? null;
  const plantillaCruda = datos.plantilla_enviada_en ?? null;
  const plantilla =
    typeof plantillaCruda === "string" && !Number.isNaN(Date.parse(plantillaCruda)) ? new Date(plantillaCruda).toISOString() : null;
  if (
    typeof nuevo !== "string" ||
    !ESTADOS_QUE_SE_ESCRIBEN.has(nuevo) ||
    (nuevo === "falla" ? !FALLAS_DE_WABA.includes(falla as FallaDeWaba) : falla !== null) ||
    (nombre !== null && !(typeof nombre === "string" && NOMBRE_ESTADO.test(nombre))) ||
    (plantillaCruda !== null && plantilla === null)
  ) {
    return "datos_invalidos";
  }
  const filas = filasDe<Cruda>(
    await ejecutar(sql`
      update public.whatsapp_wabas b
      set estado = ${nuevo}::text, falla = ${falla as string | null}::text,
          nombre_estado = coalesce(${nombre as string | null}::text, b.nombre_estado),
          plantilla_enviada_en = coalesce(${plantilla}::timestamptz, b.plantilla_enviada_en),
          actualizado_en = now()
      where b.tenant_id = ${tenantId}::uuid and b.estado in (${enLista(desdeDe(nuevo))}) and ${ESPACIO_ACTIVO}
      returning b.tenant_id::text as tenant_id
    `)
  );
  return filas.length > 0 ? "ok" : "transicion";
}

const GUARDADOS_DE_CONEXION: ReadonlySet<string> = new Set(["ok", "no_aplica", "transicion", "de_la_plataforma", "numero_ocupado", "webhook_pendiente"]);

/**
 * Paso `conectar` del operador: el número pedido pasa a conectado con el número que Meta
 * informó, y la WABA a conectada, en UNA sentencia con su asiento. Las condiciones son las
 * de la función de la 0051, una por una; el único cambio es que el autor del asiento es
 * quien opera y que no toma el candado de la secuencia de números (el operador no corre
 * a la par de la persona sobre el mismo espacio; si lo hiciera, el índice único de
 * `phone_number_id` y el de la WABA viva son quienes frenan).
 */
async function guardarConexion(tenantId: string, datos: Record<string, unknown>, op: Actor): Promise<GuardadoDeWaba> {
  const phone = datos.phone_number_id;
  const plataforma = idDeLaPlataforma();
  if (typeof phone !== "string" || !ID_DE_META.test(phone) || !plataforma) return "datos_invalidos";
  if (phone === plataforma) return "de_la_plataforma";
  const wabaPlataforma = wabaDeLaPlataforma();
  const resultado = filasDe<{ resultado?: string }>(
    await ejecutar(sql`
      with esp as (
        select x.id from public.tenants x where x.id = ${tenantId}::uuid and ${PUEDE_CONECTAR}
      ), fila as (
        select b.tenant_id, b.estado, b.waba_id, b.numero_meta, b.numero_aceptado, b.origen, b.webhook_app_verificado_en
        from public.whatsapp_wabas b where b.tenant_id in (select id from esp)
      ), num as (
        select n.id, n.estado, n.phone_number_id, n.waba_id, n.numero_e164, n.token_cifrado is not null as con_token
        from public.whatsapp_numeros n where n.tenant_id in (select id from esp) and n.estado <> 'baja'
      ), listo as (
        select n.id as numero_id, f.numero_meta
        from fila f, num n
        where f.estado in ('suscripta', 'falta_codigo', 'falta_pin') and f.waba_id is distinct from ${wabaPlataforma}::text
          and n.estado = 'pedido' and n.phone_number_id = ${phone}::text and n.waba_id = f.waba_id and n.con_token
          and f.numero_meta is not null
          and (f.origen is distinct from 'app_propia' or f.webhook_app_verificado_en is not null)
          and (
            f.numero_aceptado
            or regexp_replace(f.numero_meta, '^[+]549', '+54') = regexp_replace(n.numero_e164, '^[+]549', '+54')
          )
      ), libre as (
        select l.numero_id, l.numero_meta from listo l
        where not exists (
          select 1 from public.whatsapp_numeros o
          where o.id <> l.numero_id and o.estado <> 'baja'
            and regexp_replace(o.numero_e164, '^[+]549', '+54') = regexp_replace(l.numero_meta, '^[+]549', '+54')
        )
      ), u as (
        update public.whatsapp_numeros w
        set numero_e164 = l.numero_meta, estado = 'conectado', conectado_en = now(), actualizado_en = now()
        from libre l
        where w.id = l.numero_id and w.estado = 'pedido'
        returning w.id, w.tenant_id
      ), v as (
        update public.whatsapp_wabas b set estado = 'conectada', falla = null, actualizado_en = now()
        where b.tenant_id in (select tenant_id from u) and b.estado in ('suscripta', 'falta_codigo', 'falta_pin')
        returning b.tenant_id
      ), a as (
        ${asiento(op, AuditEvent.WHATSAPP_NUMERO_CONECTADO, "whatsapp_numero", json({ via: "embedded_signup", phone_number_id: phone }))}
      )
      select case
        when exists (select 1 from u) then 'ok'
        when not exists (select 1 from esp) then 'no_aplica'
        when not exists (select 1 from fila) then 'transicion'
        when exists (select 1 from fila where waba_id = ${wabaPlataforma}::text) then 'de_la_plataforma'
        when exists (
          select 1 from fila f, num n
          where f.estado = 'conectada' and n.estado = 'conectado' and n.phone_number_id = ${phone}::text
        ) then 'ok'
        when not exists (select 1 from fila where estado in ('suscripta', 'falta_codigo', 'falta_pin')) then 'transicion'
        when exists (
          select 1 from fila where origen = 'app_propia' and webhook_app_verificado_en is null
        ) then 'webhook_pendiente'
        when not exists (select 1 from listo) then 'no_aplica'
        else 'numero_ocupado'
      end as resultado
    `)
  )[0]?.resultado;
  const guardado = typeof resultado === "string" && GUARDADOS_DE_CONEXION.has(resultado) ? (resultado as GuardadoDeWaba) : "error";
  if (guardado === "ok") await espejarSinFallar(tenantId);
  return guardado;
}

/**
 * El almacén de la WABA con el operador de por medio. Lee con el rol dueño (el token y el
 * PIN se abren con el AAD del espacio y la WABA, como en el almacén del espacio) y
 * escribe lo mismo que la función de la 0051 pero con el operador como autor. El
 * operador sólo retoma lo que quedó a medias: `estado` y `conectar`; el resto de los
 * pasos son de la persona y acá no existen.
 */
export function almacenDelDueno(tenantId: string, op: Actor): Almacen {
  return {
    async leer() {
      try {
        const f = filasDe<Cruda>(
          await ejecutar(sql`
            select b.estado, b.falla, b.waba_id, b.business_id, b.numero_meta, b.numero_aceptado, b.nombre_estado,
                   b.plantilla_enviada_en, b.pin_cifrado,
                   b.origen, b.app_id, b.app_secreto_cifrado, b.ruta_webhook, b.webhook_app_verificado_en, b.datos_app_en,
                   b.primer_mensaje_en, b.primera_respuesta_en, b.slug_legal, b.razon_social, b.cuit, b.acuerdo_version,
                   b.recordatorio_en, b.puede_enviar,
                   n.estado as numero_estado, n.phone_number_id, n.numero_e164 as numero_tipeado,
                   n.waba_id as waba_del_numero, n.token_cifrado, t.contact_email
            from public.tenants t
            left join public.whatsapp_wabas b on b.tenant_id = t.id
            left join public.whatsapp_numeros n on n.tenant_id = t.id and n.estado <> 'baja'
            where t.id = ${tenantId}::uuid and t.autoalta
            limit 1
          `)
        )[0];
        if (!f) return null;
        const wabaId = texto(f.waba_id);
        const plantilla = fecha(f.plantilla_enviada_en);
        const appId = texto(f.app_id);
        const cuando = (v: unknown): Date | null => {
          const iso = fecha(v);
          return iso ? new Date(iso) : null;
        };
        const puedeEnviar = texto(f.puede_enviar);
        const fila: FilaDeWaba = {
          estado: texto(f.estado),
          falla: texto(f.falla),
          wabaId,
          businessId: texto(f.business_id),
          phoneNumberId: texto(f.phone_number_id),
          numeroTipeado: texto(f.numero_tipeado),
          numeroMeta: texto(f.numero_meta),
          numeroAceptado: f.numero_aceptado === true,
          // El token es de la fila del número, pero sólo vale si es el de esta WABA.
          token: wabaId && f.waba_del_numero === wabaId ? abrirSobre(texto(f.token_cifrado), aadDelToken(tenantId, wabaId)) : null,
          pin: wabaId ? abrirSobre(texto(f.pin_cifrado), aadDelPin(tenantId, wabaId)) : null,
          nombreEstado: texto(f.nombre_estado),
          plantillaEnviadaEn: plantilla ? new Date(plantilla) : null,
          numeroEstado: texto(f.numero_estado),
          emailDeContacto: texto(f.contact_email),
          origen: texto(f.estado) === null ? null : f.origen === "app_propia" ? "app_propia" : "embedded_signup",
          appId,
          // Un secreto que no abre queda en null: la acción que lo necesita pide cargarlo de nuevo.
          secreto: appId ? abrirSobre(texto(f.app_secreto_cifrado), aadDelSecreto(tenantId, appId)) : null,
          ruta: texto(f.ruta_webhook),
          webhookAppVerificadoEn: cuando(f.webhook_app_verificado_en),
          datosAppEn: cuando(f.datos_app_en),
          primerMensajeEn: cuando(f.primer_mensaje_en),
          primeraRespuestaEn: cuando(f.primera_respuesta_en),
          slugLegal: texto(f.slug_legal),
          razonSocial: texto(f.razon_social),
          cuit: texto(f.cuit),
          acuerdoVersion: texto(f.acuerdo_version),
          recordatorioEn: cuando(f.recordatorio_en),
          puedeEnviar: puedeEnviar === "AVAILABLE" || puedeEnviar === "LIMITED" || puedeEnviar === "BLOCKED" ? puedeEnviar : null,
        };
        return fila;
      } catch (e) {
        if (FALTA_LA_0048.has(codigoPg(e) ?? "")) return null;
        throw e;
      }
    },

    async guardar(paso, datos) {
      try {
        if (paso === "estado") return await guardarEstado(tenantId, datos);
        if (paso === "conectar") return await guardarConexion(tenantId, datos, op);
        return "datos_invalidos";
      } catch (e) {
        const codigo = codigoPg(e) ?? "";
        if (codigo === "23505") return "id_ocupado";
        if (FALTA_LA_0048.has(codigo)) return "sin_migracion";
        logger.error({ error: nombreDelError(e), codigo }, "alta.waba_guardado_fallo");
        return "error";
      }
    },
  };
}

/**
 * Retoma una WABA que quedó a medias o en falla: suscribe la app de nuevo, mira qué
 * falta del número y lo deja conectado. Es lo mismo que hace la persona al volver a
 * /conectar-whatsapp, con el operador de autor. Una conexión sana no se toca, y sin
 * token no hay a quién pedirle: el cliente abre el popup otra vez.
 */
export async function reintentarWaba(tenantId: string, op: Operador): Promise<ResultadoDelPanel> {
  const r: ResultadoDeApp = await continuarWaba(tenantId, almacenDelDueno(tenantId, op));
  // Lo que quedó (código pendiente, falla, conectada) se ve en el estado de la fila; acá sólo lo que el operador no puede arreglar.
  if (r === "vencido") return "waba_sin_token";
  if (r === "apagado" || r === "de_la_plataforma") return "no_aplica";
  if (r === "meta") return "meta_no_responde";
  return "waba_reintentada";
}

/** Una WABA que se dio de baja, con lo que hace falta para soltarla en Meta. */
export interface BajaDeWaba {
  tenantId: string;
  wabaId: string | null;
  /** El número vivo que la baja cerró, o null si el espacio no tenía uno de esta WABA. */
  phoneNumberId: string | null;
  numeroEstado: string | null;
  /** El token del cliente, ya abierto: se lee antes de borrarlo y después no hay otro. */
  token: string | null;
  /**
   * Sólo en la app propia del cliente: lo que hace falta para hablarle a Graph con su app. La baja ya borró el
   * secreto, así que el `appsecret_proof` se arma acá, antes; con «Require App Secret» prendido, Meta rechaza
   * sin él el `deregister` y la baja de la app. Sin `prueba` es que el secreto no abrió.
   */
  app?: { prueba?: string };
}

export type DondeDeLaBaja = { tenantId: string } | { wabaId: string } | { fbUserId: string };

/**
 * Da de baja la WABA propia de quien sea que `donde` encuentre —un espacio, una WABA o el
 * usuario de Facebook que la conectó, que puede haber conectado varias—: el número vivo
 * de esa WABA queda en baja sin token, la fila de la WABA en revocada sin PIN y todo con
 * su asiento, en UNA sentencia. La WABA de la plataforma no se toca nunca.
 *
 * Con `codigoDeBorrado` (el pedido de borrado de Meta) la misma sentencia asienta además
 * `META_BORRADO_DE_DATOS` por cada WABA dada de baja: sin baja sin constancia ni al revés.
 *
 * Devuelve lo dado de baja con el token ya abierto (leído antes del borrado, de la misma
 * foto de la base) para que quien llama lo suelte en Meta. Si la 0051 no está, tira.
 * Sólo cuando es Meta quien la saca la WABA queda con la falla `token_vencido`, para que
 * el cliente sepa por qué tiene que volver a conectar.
 */
export async function bajaDeWaba(donde: DondeDeLaBaja, actor: Actor, codigoDeBorrado?: string): Promise<BajaDeWaba[]> {
  const cual =
    "tenantId" in donde
      ? sql`b.tenant_id = ${donde.tenantId}::uuid`
      : "wabaId" in donde
        ? sql`b.waba_id = ${donde.wabaId}::text`
        : sql`b.fb_user_id = ${donde.fbUserId}::text`;
  const carga = json({ via: typeof actor === "string" ? actor : "operador" });
  // Con el pedido de borrado de Meta, el asiento con el código que se le contesta entra en la misma sentencia.
  const constancia = codigoDeBorrado
    ? sql`, a3 as (
        ${asiento(actor, AuditEvent.META_BORRADO_DE_DATOS, "whatsapp_waba", json({ codigo: codigoDeBorrado }), sql`(select b.tenant_id, coalesce(b.waba_id, b.tenant_id::text) as id from b) u`)}
      )`
    : sql``;
  const filas = filasDe<Cruda>(
    await ejecutar(sql`
      with b as (
        select b.tenant_id, b.waba_id, b.origen, b.app_id, b.app_secreto_cifrado
        from public.whatsapp_wabas b
        where ${cual} and b.estado in (${ESTADOS_VIVOS})
          and (b.waba_id is null or b.waba_id is distinct from ${wabaDeLaPlataforma()}::text)
          and exists (select 1 from public.tenants x where x.id = b.tenant_id and x.autoalta)
      ), n as (
        select w.id, w.tenant_id, w.phone_number_id, w.estado, w.token_cifrado
        from public.whatsapp_numeros w
        join b on b.tenant_id = w.tenant_id and b.waba_id = w.waba_id
        where w.estado <> 'baja'
      ), un as (
        update public.whatsapp_numeros w set estado = 'baja', token_cifrado = null, actualizado_en = now()
        from n
        where w.id = n.id and w.estado in ('pedido', 'conectado', 'suspendido')
        returning w.id, w.tenant_id
      ), u as (
        update public.whatsapp_wabas w set ${actor === "meta" ? REVOCADA_POR_META : REVOCADA}
        from b
        where w.tenant_id = b.tenant_id and w.estado in (${ESTADOS_VIVOS})
        returning w.tenant_id as id, w.tenant_id
      ), ur as (
        select u.tenant_id, coalesce(b.waba_id, u.tenant_id::text) as id
        from u join b on b.tenant_id = u.tenant_id
        where not exists (select 1 from un x where x.tenant_id = u.tenant_id)
      ), a1 as (
        ${asiento(actor, AuditEvent.WHATSAPP_NUMERO_BAJA, "whatsapp_numero", carga, sql`un u`)}
      ), a2 as (
        ${asiento(actor, AuditEvent.WHATSAPP_WABA_REVOCADA, "whatsapp_waba", carga, sql`ur u`)}
      )${constancia}
      select b.tenant_id::text as tenant_id, b.waba_id, b.origen, b.app_id, b.app_secreto_cifrado, n.phone_number_id, n.estado as numero_estado, n.token_cifrado
      from b left join n on n.tenant_id = b.tenant_id
    `)
  );
  const bajas = filas.map((f): BajaDeWaba => {
    const tenantId = String(f.tenant_id);
    const wabaId = texto(f.waba_id);
    const appId = texto(f.app_id);
    const token = wabaId ? abrirSobre(texto(f.token_cifrado), aadDelToken(tenantId, wabaId)) : null;
    const secreto = appId ? abrirSobre(texto(f.app_secreto_cifrado), aadDelSecreto(tenantId, appId)) : null;
    return {
      tenantId,
      wabaId,
      phoneNumberId: texto(f.phone_number_id),
      numeroEstado: texto(f.numero_estado),
      token,
      ...(f.origen === "app_propia" ? { app: { prueba: token && secreto ? pruebaDelSecreto(token, secreto) : undefined } } : {}),
    };
  });
  // La copia del cliente sólo lleva el número: sin fila de número no cambió nada que espejar.
  for (const b of bajas) if (b.numeroEstado) await espejarSinFallar(b.tenantId);
  return bajas;
}

/**
 * El operador desconecta al cliente: el token y el PIN se borran, el número queda en baja
 * y la WABA revocada; después, ya sin esperar, se da de baja el número en Meta y se saca
 * la app (`soltarEnMeta`). Es lo que hace falta cuando el cliente no puede hacerlo él.
 */
export async function desvincularWaba(tenantId: string, op: Operador): Promise<ResultadoDeAccion> {
  let bajas: BajaDeWaba[];
  try {
    bajas = await bajaDeWaba({ tenantId }, op);
  } catch (e) {
    if (FALTA_LA_0048.has(codigoPg(e) ?? "")) return "migracion_pendiente";
    throw e;
  }
  if (bajas.length === 0) return "no_aplica";
  for (const { token, wabaId, phoneNumberId, app } of bajas) {
    // El número en «pedido» puede estar ya registrado en Meta: `soltarEnMeta` mira y lo da de baja sólo si lo está.
    if (token && wabaId) after(() => soltarEnMeta(tenantId, token, wabaId, phoneNumberId, app));
  }
  return "ok";
}

/** Meta avisó, y Graph lo confirmó, que el cliente sacó la app: la WABA queda revocada. Sin token que soltar, porque ya no sirve. */
export async function wabaRevocada(wabaId: string): Promise<void> {
  await bajaDeWaba({ wabaId }, "meta");
}

/**
 * La WABA conectada dejó de andar por algo que sólo el cliente arregla: marca la falla
 * sin tocar el número ni el token. Sale de `conectada`; una falla anterior, o una conexión
 * que todavía no terminó, no se pisa con esto. La única excepción: un token o un secreto que
 * murieron bajo una restricción o un bloqueo de Meta pisan la restricción, porque hasta que
 * el cliente los renueve no hay forma de saber si Meta la levantó.
 *
 * `secretoCifrado` ata la falla al secreto que se miró: si el cliente ya lo cambió, la
 * falla era del secreto viejo y no se marca. Devuelve si la fila cambió, para que quien
 * avisa al operador no avise de lo que no pasó.
 */
export async function wabaEnFalla(
  tenantId: string,
  falla: Extract<
    FallaDeWaba,
    "token_vencido" | "nombre_rechazado" | "secreto_invalido" | "waba_restringida" | "waba_bloqueada" | "pago_pendiente"
  >,
  { secretoCifrado }: { secretoCifrado?: string } = {}
): Promise<boolean> {
  const pisaUnaRestriccion = falla === "token_vencido" || falla === "secreto_invalido";
  const filas = filasDe<Cruda>(
    await ejecutar(sql`
      update public.whatsapp_wabas b set estado = 'falla', falla = ${falla}::text, actualizado_en = now()
      where b.tenant_id = ${tenantId}::uuid
        and (b.estado = 'conectada'
          or (${pisaUnaRestriccion}::boolean and b.estado = 'falla' and b.falla in ('waba_restringida', 'waba_bloqueada')))
        ${secretoCifrado === undefined ? sql`` : sql`and b.app_secreto_cifrado = ${secretoCifrado}::text`}
      returning b.tenant_id
    `)
  );
  if (filas.length > 0) logger.warn({ tenantId, falla }, "whatsapp.waba_en_falla");
  return filas.length > 0;
}

/**
 * Meta dejó de restringir o bloquear la cuenta (la salud del número vuelve a decir `AVAILABLE`): la WABA
 * vuelve de `falla` (`waba_restringida` o `waba_bloqueada`) a `conectada`. E12 no tiene salida del lado del
 * cliente y ningún aviso de Meta dice que se levantó, así que lo decide la revisión nocturna. Igual que
 * `nombreRehabilitado`: es un hecho que Graph confirmó, sin asiento, y sólo con el número todavía vivo.
 */
export async function restriccionLevantada(tenantId: string): Promise<boolean> {
  const filas = filasDe<Cruda>(
    await ejecutar(sql`
      update public.whatsapp_wabas b set estado = 'conectada', falla = null, actualizado_en = now()
      where b.tenant_id = ${tenantId}::uuid and b.origen = 'app_propia' and b.estado = 'falla'
        and b.falla in ('waba_restringida', 'waba_bloqueada')
        and exists (
          select 1 from public.whatsapp_numeros n
          where n.tenant_id = b.tenant_id and n.waba_id = b.waba_id and n.estado in ('conectado', 'suspendido')
        )
      returning b.tenant_id
    `)
  );
  return filas.length > 0;
}

/**
 * Meta aprobó el nombre visible que había rechazado y el número ya se registró de nuevo: la WABA vuelve de
 * `falla` (`nombre_rechazado`) a `conectada`. El paso `estado` de la función no puede ir de `falla` a
 * `conectada`, y es un hecho que Graph confirmó, no una decisión de alguien: sin asiento ni espejo (el número
 * no cambió). Sólo con el número todavía vivo; un número dado de baja no se rehabilita.
 */
export async function nombreRehabilitado(tenantId: string): Promise<boolean> {
  const filas = filasDe<Cruda>(
    await ejecutar(sql`
      update public.whatsapp_wabas b
      set estado = 'conectada', falla = null, nombre_estado = 'APPROVED', actualizado_en = now()
      where b.tenant_id = ${tenantId}::uuid and b.estado = 'falla' and b.falla = 'nombre_rechazado'
        and exists (
          select 1 from public.whatsapp_numeros n
          where n.tenant_id = b.tenant_id and n.waba_id = b.waba_id and n.estado in ('conectado', 'suspendido')
        )
      returning b.tenant_id
    `)
  );
  return filas.length > 0;
}

/** Se le mandó al cliente el recordatorio de un alta de la app propia que quedó a medias: es uno solo por alta. */
export async function recordatorioEnviado(tenantId: string): Promise<void> {
  await ejecutar(sql`
    update public.whatsapp_wabas b set recordatorio_en = now()
    where b.tenant_id = ${tenantId}::uuid and b.estado = 'armando' and b.recordatorio_en is null
  `);
}

/**
 * La plantilla de reapertura quedó creada en la WABA: la revisión de salud no la vuelve a pedir.
 * No toca `actualizado_en`: marca el último cambio de estado, y un aviso de Meta anterior a
 * esa hora se descarta por viejo (`eventos-de-cuenta.ts`).
 */
export async function plantillaCreada(tenantId: string): Promise<void> {
  await ejecutar(sql`
    update public.whatsapp_wabas b set plantilla_enviada_en = now()
    where b.tenant_id = ${tenantId}::uuid and b.estado = 'conectada' and b.plantilla_enviada_en is null
  `);
}

/** Lo que Meta dice de la aprobación del nombre del número, guardado tal cual (las mayúsculas de Graph). Tampoco mueve `actualizado_en`. */
export async function nombreDelNumero(wabaId: string, nombreEstado: string): Promise<void> {
  if (!NOMBRE_ESTADO.test(nombreEstado)) return;
  await ejecutar(sql`
    update public.whatsapp_wabas b set nombre_estado = ${nombreEstado}::text
    where b.waba_id = ${wabaId}::text and b.estado not in ('revocada', 'cancelada')
  `);
}

// ── La app propia: lo que pasa por su webhook y por su envío ───────────────────

/**
 * Meta llamó con el token del apretón de manos a la ruta de una app propia: el cliente ya pegó
 * la dirección en su app. Devuelve false si la ruta no es de ninguna fila viva, y entonces el
 * webhook contesta 404 en vez de repetirle el desafío a quien sólo conoce el token.
 */
export async function webhookDeAppVerificado(ruta: string): Promise<boolean> {
  const filas = filasDe<Cruda>(
    await ejecutar(sql`
      update public.whatsapp_wabas b set webhook_app_verificado_en = now(), actualizado_en = now()
      where b.ruta_webhook = ${ruta}::text and b.origen = 'app_propia' and b.estado not in ('revocada', 'cancelada')
      returning b.tenant_id
    `)
  );
  return filas.length > 0;
}

/**
 * Entró el primer mensaje por el webhook de la app propia y se guardó: la fila lo anota una sola vez.
 * Sólo en `conectada` o `falla`, como el resto de lo que prueba el alta de punta a punta; antes, nadie
 * lo atendió.
 */
export async function primerMensajeDeApp(tenantId: string): Promise<void> {
  await ejecutar(sql`
    update public.whatsapp_wabas b set primer_mensaje_en = now()
    where b.tenant_id = ${tenantId}::uuid and b.origen = 'app_propia' and b.primer_mensaje_en is null
      and b.estado in ('conectada', 'falla')
  `);
}

/**
 * Meta aceptó la primera respuesta que sale por la app propia: con eso el alta está probada de
 * punta a punta. Si esa misma respuesta venía de una falla `pago_pendiente` (el 131042 de
 * Meta), la fila vuelve a `conectada`; después de la primera, la salud decide.
 */
export async function primeraRespuestaDeApp(tenantId: string): Promise<void> {
  await ejecutar(sql`
    update public.whatsapp_wabas b set
      primera_respuesta_en = now(),
      estado = case when b.estado = 'falla' and b.falla = 'pago_pendiente' then 'conectada' else b.estado end,
      falla = case when b.estado = 'falla' and b.falla = 'pago_pendiente' then null else b.falla end,
      actualizado_en = case when b.estado = 'falla' and b.falla = 'pago_pendiente' then now() else b.actualizado_en end
    where b.tenant_id = ${tenantId}::uuid and b.origen = 'app_propia' and b.primera_respuesta_en is null
      and b.estado in ('conectada', 'falla')
  `);
}

/** Si Graph dice que el número de la app propia puede enviar (la revisión de salud), guardado tal cual para el panel. */
export async function saludDeApp(tenantId: string, puedeEnviar: "AVAILABLE" | "LIMITED" | "BLOCKED"): Promise<void> {
  await ejecutar(sql`
    update public.whatsapp_wabas b set puede_enviar = ${puedeEnviar}::text
    where b.tenant_id = ${tenantId}::uuid and b.origen = 'app_propia' and b.estado in ('conectada', 'falla')
      and b.puede_enviar is distinct from ${puedeEnviar}::text
  `);
}

/**
 * El operador baja las páginas legales públicas de un cliente de la app propia (se fue del alta o pidió
 * que se borren sus datos): el slug se borra y la ruta contesta 404 en cualquier estado de la fila. Si el
 * cliente vuelve a empezar, el alta crea un slug nuevo; su app de Meta sigue apuntando a las direcciones
 * viejas hasta que las cambie. Sólo de control: la base del cliente no copia esta tabla.
 */
export function despublicarLegales(tenantId: string, op: Operador): Promise<ResultadoDeAccion> {
  return aplicar(
    sql`
    with u as (
      update public.whatsapp_wabas b set slug_legal = null, actualizado_en = now()
      where b.tenant_id = ${tenantId}::uuid and b.origen = 'app_propia' and b.slug_legal is not null
      returning b.tenant_id, coalesce(b.waba_id, b.tenant_id::text) as id
    ), a as (
      ${asiento(op, AuditEvent.WHATSAPP_APP_LEGALES_DESPUBLICADAS, "whatsapp_waba", json({ via: "operador" }))}
    )
    ${CUENTA_DE_U}
  `,
    false
  );
}

// ── El inquilino ────────────────────────────────────────────────────────────

/** Suspende un espacio en prueba o activo: deja de recibir lo que le llega (ver `resolverNumeros`). */
export function suspenderInquilino(tenantId: string, op: Operador): Promise<ResultadoDeAccion> {
  return aplicar(sql`
    with u as (
      update public.tenants t set billing_status = 'suspended'
      where t.id = ${tenantId}::uuid and t.autoalta and t.billing_status in ('trial', 'active')
      returning t.id, t.id as tenant_id
    ), a as (
      ${asiento(op, AuditEvent.TENANT_SUSPENDED, "tenant", json({ estado: "suspended" }))}
    )
    ${CUENTA_DE_U}
  `);
}

/** Levanta la suspensión: vuelve a `active` si alguna vez se activó (pagó), y a `trial` si nunca. */
export function reactivarInquilino(tenantId: string, op: Operador): Promise<ResultadoDeAccion> {
  return aplicar(sql`
    with u as (
      update public.tenants t
      set billing_status = case when t.activated_at is not null then 'active' else 'trial' end
      where t.id = ${tenantId}::uuid and t.autoalta and t.billing_status = 'suspended'
      returning t.id, t.id as tenant_id, t.billing_status
    ), a as (
      ${asiento(op, AuditEvent.TENANT_SUSPENDED, "tenant", sql`jsonb_build_object('estado', u.billing_status)`)}
    )
    ${CUENTA_DE_U}
  `);
}

/**
 * Pone el fin de la prueba a `dias` días desde hoy (1 a 90). Sólo la alarga: si
 * ya llega más lejos, no cambia nada.
 */
export function extenderPrueba(tenantId: string, dias: number, op: Operador): Promise<ResultadoDeAccion> {
  if (!Number.isInteger(dias) || dias < 1 || dias > DIAS_MAXIMOS_DE_PRUEBA) return Promise.resolve("no_aplica");
  return aplicar(sql`
    with u as (
      update public.tenants t set trial_ends_at = now() + make_interval(days => ${dias}::int)
      where t.id = ${tenantId}::uuid and t.autoalta and t.billing_status = 'trial'
        and (t.trial_ends_at is null or t.trial_ends_at < now() + make_interval(days => ${dias}::int))
      returning t.id, t.id as tenant_id, t.trial_ends_at
    ), a as (
      ${asiento(op, AuditEvent.TENANT_PLAN_CHANGED, "tenant", sql`jsonb_build_object('prueba_hasta', u.trial_ends_at)`)}
    )
    ${CUENTA_DE_U}
  `);
}

export interface TerminosDeActivacion {
  plan: Plan;
  monthly_fee_usd: string;
  included_claims: number;
  overage_price_usd: string;
}

const DECIMAL = /^\d{1,7}(?:\.\d{1,4})?$/;

/**
 * Los términos con que se activa: los del catálogo del plan, salvo lo que el
 * operador pisa a mano (un acuerdo distinto). Null si el plan no existe o un
 * valor escrito no es un número razonable.
 */
export function terminosDeActivacion(
  plan: unknown,
  pisados: { cuota?: string; incluidas?: string; excedente?: string } = {}
): TerminosDeActivacion | null {
  if (!isPlan(plan)) return null;
  const base = PLAN_CATALOG[plan];
  const cuota = pisados.cuota?.trim() || String(base.monthly_fee_usd);
  const excedente = pisados.excedente?.trim() || String(base.overage_price_usd);
  const incluidas = pisados.incluidas?.trim() ? Number(pisados.incluidas.trim()) : base.included_claims;
  if (!DECIMAL.test(cuota) || !DECIMAL.test(excedente)) return null;
  if (!Number.isInteger(incluidas) || incluidas < 0 || incluidas > 10_000_000) return null;
  return { plan, monthly_fee_usd: cuota, included_claims: incluidas, overage_price_usd: excedente };
}

/**
 * Pasa un espacio a pago: el plan, `billing_status = 'active'` y los términos de
 * facturación. `activated_at` marca la primera activación y no se pisa después.
 * Deja de ser «en prueba», así que se le levantan los topes de la prueba.
 */
export function activarInquilino(
  tenantId: string,
  terminos: TerminosDeActivacion,
  op: Operador
): Promise<ResultadoDeAccion> {
  return aplicar(sql`
    with antes as (
      select t.id, t.plan as plan_anterior
      from public.tenants t
      where t.id = ${tenantId}::uuid and t.autoalta and t.billing_status in ('trial', 'active')
    ), u as (
      update public.tenants t
      set plan = ${terminos.plan}::text, billing_status = 'active',
          monthly_fee_usd = ${terminos.monthly_fee_usd}::numeric, included_claims = ${terminos.included_claims}::int,
          overage_price_usd = ${terminos.overage_price_usd}::numeric, activated_at = coalesce(t.activated_at, now())
      from antes x
      where t.id = x.id
      returning t.id, t.id as tenant_id
    ), a as (
      ${asiento(
        op,
        AuditEvent.TENANT_PLAN_CHANGED,
        "tenant",
        sql`jsonb_build_object('de', (select plan_anterior from antes), 'a', ${terminos.plan}::text, 'estado', 'active')`
      )}
    )
    ${CUENTA_DE_U}
  `);
}
