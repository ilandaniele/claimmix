/**
 * Las WABAs propias de los clientes, leídas con su token abierto, para quien las
 * revisa de noche (`waba-salud.ts`) y para quien atiende lo que Meta avisa de ellas
 * (`eventos-de-cuenta.ts`). Sólo lee: lo que se escribe vive en `panel-operador.ts`.
 *
 * El token es de la fila del número, no de la WABA, y sólo vale si el número es el de
 * esta WABA: por eso el cruce por `waba_id` además del espacio.
 */

import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { filasDe } from "@/lib/db/filas";
import type { Locale } from "@/lib/i18n";
import type { OrigenDeWaba } from "@/server/alta/waba-resultados";
import { aadDelSecreto, aadDelToken, abrirSobre } from "@/server/whatsapp/sobres-del-cliente";

export interface WabaDelCliente {
  tenantId: string;
  wabaId: string;
  estado: string;
  /** Cómo nació la fila: por el popup de Meta o con la app que creó el cliente. */
  origen: OrigenDeWaba;
  /** Epoch ms de la última vez que cambió la fila; null si la base no lo trajo. */
  actualizadoEn: number | null;
  plantillaEnviada: boolean;
  /** Abierto; null si el número no está, ya se dio de baja o el sobre no abre. */
  token: string | null;
  /** Por qué cayó la fila; null si no está en falla. */
  falla: string | null;
  /** Sólo con la app propia: su App ID y su App Secret abierto (null si el sobre no abre). */
  appId: string | null;
  secreto: string | null;
  /** El número de la WABA; null si no hay o ya se dio de baja. */
  phoneNumberId: string | null;
}

// sin-inquilino: Recorre las WABAs de todos los clientes a propósito: Meta avisa por
// WABA y la revisión de salud pasa por todas; el espacio sale de la fila.
const ejecutar = (consulta: SQL) => db.execute(consulta);

const aMs = (v: unknown): number | null => {
  const ms = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Las filas de `whatsapp_wabas` que cumplen `donde` (el alias de la tabla es `b`), a
 * lo sumo `limite`. Sin la 0051 la consulta tira el 42P01 de Postgres: quien llama decide.
 */
export async function leerWabasDelCliente(donde: SQL, limite: number, orden: SQL = sql`b.actualizado_en asc`): Promise<WabaDelCliente[]> {
  const filas = filasDe<Record<string, unknown>>(
    await ejecutar(sql`
      select b.tenant_id::text as tenant_id, b.waba_id, b.estado, b.origen, b.actualizado_en,
             (b.plantilla_enviada_en is not null) as plantilla_enviada, b.falla, b.app_id, b.app_secreto_cifrado,
             n.token_cifrado, n.phone_number_id
      from public.whatsapp_wabas b
      left join public.whatsapp_numeros n on n.tenant_id = b.tenant_id and n.waba_id = b.waba_id and n.estado <> 'baja'
      where b.waba_id is not null and ${donde}
      order by ${orden}
      limit ${limite}::int
    `)
  );
  return filas.flatMap((f) => {
    if (typeof f.tenant_id !== "string" || typeof f.waba_id !== "string" || typeof f.estado !== "string") return [];
    return [
      {
        tenantId: f.tenant_id,
        wabaId: f.waba_id,
        estado: f.estado,
        origen: f.origen === "app_propia" ? "app_propia" : "embedded_signup",
        actualizadoEn: aMs(f.actualizado_en),
        plantillaEnviada: f.plantilla_enviada === true,
        token: typeof f.token_cifrado === "string" ? abrirSobre(f.token_cifrado, aadDelToken(f.tenant_id, f.waba_id)) : null,
        falla: typeof f.falla === "string" ? f.falla : null,
        appId: typeof f.app_id === "string" ? f.app_id : null,
        secreto:
          typeof f.app_id === "string" && typeof f.app_secreto_cifrado === "string"
            ? abrirSobre(f.app_secreto_cifrado, aadDelSecreto(f.tenant_id, f.app_id))
            : null,
        phoneNumberId: typeof f.phone_number_id === "string" ? f.phone_number_id : null,
      },
    ];
  });
}

export interface AltaAMedias {
  tenantId: string;
  appId: string | null;
  webhookVerificado: boolean;
  /** La dirección de contacto del espacio; null si no tiene. */
  correo: string | null;
  /** El idioma del dueño del espacio: el del mail que se le manda. */
  locale: Locale;
}

// sin-inquilino: El recordatorio recorre los espacios de todos los clientes a propósito: busca
// las altas de la app propia que quedaron a medias, y el espacio sale de la fila.
const ejecutarRecordatorio = (consulta: SQL) => db.execute(consulta);

/**
 * Las altas de la app propia que siguen en `armando` (sin WABA todavía), sin recordatorio
 * enviado y sin cambios hace más de `horas`. Las más viejas primero, a lo sumo `limite`.
 */
export async function leerAltasAMedias(horas: number, limite: number): Promise<AltaAMedias[]> {
  const filas = filasDe<Record<string, unknown>>(
    await ejecutarRecordatorio(sql`
      select b.tenant_id::text as tenant_id, b.app_id, (b.webhook_app_verificado_en is not null) as verificado, t.contact_email,
        (select u.locale from public.users u where u.tenant_id = b.tenant_id and u.role = 'owner' order by u.created_at asc limit 1) as locale
      from public.whatsapp_wabas b
      join public.tenants t on t.id = b.tenant_id
      where b.origen = 'app_propia' and b.estado = 'armando' and b.recordatorio_en is null
        and b.actualizado_en < now() - make_interval(hours => ${horas}::int)
      order by b.actualizado_en asc
      limit ${limite}::int
    `)
  );
  return filas.flatMap((f) => {
    if (typeof f.tenant_id !== "string") return [];
    return [
      {
        tenantId: f.tenant_id,
        appId: typeof f.app_id === "string" ? f.app_id : null,
        webhookVerificado: f.verificado === true,
        correo: typeof f.contact_email === "string" && f.contact_email.trim() !== "" ? f.contact_email.trim() : null,
        locale: f.locale === "en-US" ? "en-US" : "es-AR",
      },
    ];
  });
}
