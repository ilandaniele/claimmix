/**
 * Lo que el operador lee y escribe sobre las altas automáticas.
 *
 * Es el ÚNICO archivo de `src/` que escribe `tenants` y `whatsapp_numeros` con
 * el rol dueño (lo vigila `pnpm arquitectura`): la app, con `claimmix_app`, no
 * tiene permiso sobre ellas desde la 0048, y el rol dueño no tiene RLS. Cruzar
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
 * y que el número de la plataforma siga cortado.
 *
 * Todo tolera que la 0048 todavía no esté aplicada (42P01 / 42703 / 42883): la
 * lectura avisa que falta y las acciones devuelven `migracion_pendiente`.
 *
 * Con `BASE_POR_CLIENTE` el rol dueño apunta a control, que es donde se escribe. Cada
 * cambio que sale bien se espeja a la base del cliente (el espejo lleva el número y
 * `billing_status`): si la copia no entra la acción devuelve `espejo_pendiente`, que
 * no es un fallo —el cambio ya está— y el barrido la levanta.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { AuditEvent } from "@/lib/audit/log";
import { PLAN_CATALOG, isPlan, type Plan } from "@/lib/billing/plans";
import { db } from "@/lib/db";
import { conteoDe, filasDe } from "@/lib/db/filas";
import { topeGlobalDelDia } from "@/server/alta/crear-inquilino";
import { esNumeroDeOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { codigoPg } from "@/server/core-sync/config";
import { idDeLaPlataforma, inquilinoDeLaPlataforma } from "@/server/whatsapp/numeros";
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

/** Las columnas y la tabla que la 0048 agrega, y la función: sin ellas el panel no tiene de dónde leer. */
const FALTA_LA_0048 = new Set(["42P01", "42703", "42883"]);

// sin-inquilino: El panel del operador cruza inquilinos a propósito: lista las
// altas de todos y cada acción escribe sobre el inquilino que elige quien opera.
const ejecutar = (consulta: SQL) => db.execute(consulta);

/** La fila de número es de un espacio del alta automática; `w` es la fila de `whatsapp_numeros`. */
const DEL_ALTA = sql`exists (select 1 from public.tenants x where x.id = w.tenant_id and x.autoalta)`;

const json = (valor: object): SQL => sql`${JSON.stringify(valor)}::jsonb`;

/**
 * El asiento de auditoría de una acción, para colgar de su CTE. La acción tiene
 * que llamar `u` a lo que modificó, con `id` y `tenant_id`: sin filas en `u`
 * tampoco hay asiento.
 */
function asiento(op: Operador, evento: string, objetivo: "tenant" | "whatsapp_numero", payload: SQL): SQL {
  return sql`insert into public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload, ip)
    select u.tenant_id, ${op.userId}::uuid, ${evento}::text, ${objetivo}::text, u.id::text, ${payload}, ${op.ip}::inet
    from u`;
}

/** El final de una acción: cuántas filas cambió `u` y de qué inquilino, para espejarlo. */
const CUENTA_DE_U = sql`select count(*)::int as n, min(u.tenant_id::text) as tenant_id from u`;

/** El cambio ya está en control: «ok» si la copia del cliente también entró, y «espejo_pendiente» si queda para el barrido. */
async function espejado(tenantId: unknown): Promise<ResultadoDeAccion> {
  if (typeof tenantId !== "string") return "ok";
  return (await espejarSinFallar(tenantId)) ? "ok" : "espejo_pendiente";
}

/** Corre una acción que devuelve cuántas filas cambió: ninguna es `no_aplica`, no un error. */
async function aplicar(consulta: SQL): Promise<ResultadoDeAccion> {
  try {
    const resultado = await ejecutar(consulta);
    return conteoDe(resultado) > 0 ? await espejado(filasDe<Cruda>(resultado)[0]?.tenant_id) : "no_aplica";
  } catch (e) {
    if (FALTA_LA_0048.has(codigoPg(e) ?? "")) return "migracion_pendiente";
    throw e;
  }
}

// ── La lista ────────────────────────────────────────────────────────────────

export interface OtroTitular {
  espacio: string;
  contactEmail: string | null;
  estado: string;
  desde: string | null;
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
}

type Cruda = Record<string, unknown>;

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

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
 * número, la marca de «número en revisión» (del asiento de alta), los otros
 * titulares del mismo número y cuántas altas van en 24 h. El 9 argentino se
 * ignora al comparar, igual que `mismoNumero`: «+549…» y «+54…» son el mismo.
 *
 * El conteo de 24 h va aparte de la lista para que una lista vacía igual lo traiga.
 */
export async function listarAltas(): Promise<PanelDeAltas> {
  const tope = topeGlobalDelDia();
  try {
    const filas = filasDe<Cruda>(
      await ejecutar(sql`
        select c.creadas_24h, l.*
        from (
          select count(*)::int as creadas_24h
          from public.tenants
          where autoalta and created_at > now() - interval '24 hours'
        ) c
        left join (
          select
            t.id as tenant_id, t.name as nombre, t.contact_email, t.created_at, t.plan, t.billing_status,
            t.trial_ends_at, t.activated_at,
            n.id as numero_id, n.numero_e164, n.estado as numero_estado, n.phone_number_id, n.waba_id,
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
    };
  } catch (e) {
    if (!FALTA_LA_0048.has(codigoPg(e) ?? "")) throw e;
    return { migracionPendiente: true, altas: [], creadas24h: 0, tope };
  }
}

// ── El número ───────────────────────────────────────────────────────────────

/** Meta da ids de dígitos; la tabla lo exige igual (`^[0-9]{6,20}$`), y acá se dice antes de viajar. */
const ID_DE_META = /^[0-9]{6,20}$/;

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
      where w.id = ${numeroId}::uuid and w.estado = 'pedido' and ${DEL_ALTA}
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
          where w.id = ${numeroId}::uuid and w.estado = 'pedido' and ${DEL_ALTA}
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

/** Da de baja el número. No borra: la fila conserva el id, y de él dependen la cuarentena y el historial. */
export function darDeBajaNumero(numeroId: string, op: Operador): Promise<ResultadoDeAccion> {
  return aplicar(sql`
    with u as (
      update public.whatsapp_numeros w set estado = 'baja', actualizado_en = now()
      where w.id = ${numeroId}::uuid and w.estado <> 'baja' and ${DEL_ALTA}
      returning w.id, w.tenant_id
    ), a as (
      ${asiento(op, AuditEvent.WHATSAPP_NUMERO_BAJA, "whatsapp_numero", json({ estado: "baja" }))}
    )
    ${CUENTA_DE_U}
  `);
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
