/**
 * Altas automáticas — la herramienta del operador.
 *
 * Lista los espacios que se abrieron solos y deja conectar su número de
 * WhatsApp, suspenderlos, alargar la prueba y activar el plan. Cruza
 * inquilinos y escribe con el rol dueño, así que va detrás de `requireOperator`
 * (sesión de admin, dirección del operador Y espacio de la casa); quien no lo
 * es ve su bandeja, no un 403. Cada acción vuelve a pedir la guarda por su
 * cuenta (`actions.ts`): esconder el botón no es una guarda.
 *
 * Es de servidor entero: formularios con `action`, sin JavaScript de cliente.
 * Lee todo en una consulta (`listarAltas`).
 */

import { redirect } from "next/navigation";

import { dominioDelMail } from "@/core/sso";
import { PLANS } from "@/lib/billing/plans";
import { nombreDePlan } from "@/lib/billing/plan-label";
import { requireOperator } from "@/lib/auth/require-operator";
import { AppError } from "@/lib/errors";
import { getT, type Locale, type TranslationKey } from "@/lib/i18n";
import { formatDate } from "@/lib/utils";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { llegoAlAviso } from "@/server/alta/aviso-operador";
import {
  DIAS_MAXIMOS_DE_PRUEBA,
  listarAltas,
  resultadoDelPanel,
  type FilaDeAlta,
  type ResultadoDelPanel,
} from "@/server/alta/panel-operador";

import {
  activarElInquilino,
  conectar,
  darDeBajaElNumero,
  extenderLaPrueba,
  reactivarElInquilino,
  reactivarElNumero,
  suspenderElInquilino,
  suspenderElNumero,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  trial: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  churned: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const STATUS_LABELS: Record<string, TranslationKey> = {
  active: "cartera.estado.active",
  trial: "cartera.estado.trial",
  suspended: "cartera.estado.suspended",
  churned: "cartera.estado.churned",
};

const NUMERO_LABELS: Record<string, TranslationKey> = {
  pedido: "altas.numero.estado.pedido",
  conectado: "altas.numero.estado.conectado",
  suspendido: "altas.numero.estado.suspendido",
  baja: "altas.numero.estado.baja",
};

const NUMERO_STYLES: Record<string, string> = {
  pedido: STATUS_STYLES.trial,
  conectado: STATUS_STYLES.active,
  suspendido: STATUS_STYLES.suspended,
  baja: STATUS_STYLES.churned,
};

const CAMPO =
  "rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-900";
const BOTON =
  "rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800";
const BOTON_PELIGRO =
  "rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40";

const dia = { hour: undefined, minute: undefined } as const;

export default async function AltasPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  try {
    await requireOperator();
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    // Quien llega por la URL sin ser operador ve su bandeja: que esto exista no tiene por qué constarle.
    redirect("/bandeja");
  }

  const locale = await getAccountLocale();
  const t = getT(locale);

  const crudo = (await searchParams).r;
  const resultado = resultadoDelPanel(typeof crudo === "string" ? crudo : null);
  const panel = await listarAltas();

  return (
    <div className="px-6 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t("altas.title")}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("altas.subtitle")}</p>
      </div>

      {resultado && <Resultado resultado={resultado} t={t} />}

      {panel.migracionPendiente ? (
        <p className="text-sm text-amber-700">{t("migracion.pendiente")}</p>
      ) : (
        <>
          <div className="mb-6 max-w-xs">
            <div
              className={`rounded-lg border px-4 py-3 ${
                llegoAlAviso(panel.creadas24h, panel.tope)
                  ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
                  : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
              }`}
            >
              <p className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {t("altas.stat.tope")
                  .replace("{n}", String(panel.creadas24h))
                  .replace("{tope}", String(panel.tope))}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t("altas.stat.24h")}</p>
              {panel.tope === 0 && (
                <p className="mt-0.5 text-xs text-slate-500">{t("altas.stat.cerrada")}</p>
              )}
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t("altas.col.espacio")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("altas.col.plan")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("altas.col.numero")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("altas.col.acciones")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {panel.altas.map((fila) => (
                  <Alta key={fila.tenantId} fila={fila} locale={locale} t={t} />
                ))}
                {panel.altas.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                      {t("altas.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

type Traducir = (clave: TranslationKey) => string;

function Resultado({ resultado, t }: { resultado: ResultadoDelPanel; t: Traducir }) {
  const bien = resultado === "ok";
  return (
    <p
      role="status"
      className={`mb-4 rounded border px-3 py-2 text-sm ${
        bien
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
          : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
      }`}
    >
      {t(`altas.r.${resultado}`)}
    </p>
  );
}

/** Un botón que manda una acción con sus campos ocultos. */
function Accion({
  accion,
  campos,
  etiqueta,
  peligro,
}: {
  accion: (form: FormData) => Promise<void>;
  campos: Record<string, string>;
  etiqueta: string;
  peligro?: boolean;
}) {
  return (
    <form action={accion}>
      {Object.entries(campos).map(([nombre, valor]) => (
        <input key={nombre} type="hidden" name={nombre} value={valor} />
      ))}
      <button type="submit" className={peligro ? BOTON_PELIGRO : BOTON}>
        {etiqueta}
      </button>
    </form>
  );
}

function Alta({ fila, locale, t }: { fila: FilaDeAlta; locale: Locale; t: Traducir }) {
  const { numero } = fila;
  const dominio = fila.contactEmail ? dominioDelMail(fila.contactEmail) : null;
  const estado = fila.estadoDeFacturacion;
  const enPrueba = estado === "trial";
  const operable = estado === "trial" || estado === "active";
  const repetido = fila.repetidoEn.length > 0;

  return (
    <tr className="align-top hover:bg-slate-50 dark:hover:bg-slate-800/40">
      <td className="px-4 py-3">
        <p className="font-medium text-slate-900 dark:text-slate-100">{fila.nombre}</p>
        {fila.contactEmail && (
          <p className="text-xs text-slate-500 dark:text-slate-400">{fila.contactEmail}</p>
        )}
        {dominio && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("altas.dominio")}: {dominio}
          </p>
        )}
        {fila.creadoEn && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("altas.alta")} {formatDate(fila.creadoEn, locale, dia)}
          </p>
        )}
      </td>

      <td className="px-4 py-3">
        <p className="text-slate-600 dark:text-slate-300">{nombreDePlan(fila.plan, fila.plan, t)}</p>
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            STATUS_STYLES[estado] ?? STATUS_STYLES.churned
          }`}
        >
          {STATUS_LABELS[estado] ? t(STATUS_LABELS[estado]) : estado}
        </span>
        {enPrueba && fila.pruebaHasta && (
          <span className="block text-xs text-slate-500">
            {t("altas.prueba.hasta")} {formatDate(fila.pruebaHasta, locale, dia)}
          </span>
        )}
      </td>

      <td className="px-4 py-3">
        {numero ? (
          <>
            <p className="tabular-nums text-slate-900 dark:text-slate-100">{numero.e164}</p>
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                NUMERO_STYLES[numero.estado] ?? STATUS_STYLES.churned
              }`}
            >
              {NUMERO_LABELS[numero.estado] ? t(NUMERO_LABELS[numero.estado]) : numero.estado}
            </span>
            {numero.phoneNumberId && (
              <p className="mt-1 text-xs text-slate-500">
                {t("altas.numero.phoneNumberId")}: {numero.phoneNumberId}
                {numero.wabaId && ` · ${t("altas.numero.waba")}: ${numero.wabaId}`}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-slate-500">{t("altas.numero.sinFila")}</p>
        )}

        {fila.numeroEnRevision && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            <p className="font-medium">{t("altas.enRevision.titulo")}</p>
            <p>{t("altas.enRevision.texto")}</p>
          </div>
        )}

        {repetido && (
          <div className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
            <p className="font-medium">{t("altas.duplicado.titulo")}</p>
            <p>{t("altas.duplicado.texto")}</p>
            <ul className="mt-1 space-y-0.5">
              {fila.repetidoEn.map((otro, i) => (
                <li key={i}>
                  {[
                    otro.espacio,
                    otro.contactEmail,
                    otro.contactEmail && dominioDelMail(otro.contactEmail),
                    otro.desde && formatDate(otro.desde, locale, dia),
                    otro.estado === "baja" && t("altas.duplicado.baja"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </li>
              ))}
            </ul>
          </div>
        )}
      </td>

      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {numero?.estado === "conectado" && (
            <Accion accion={suspenderElNumero} campos={{ numero_id: numero.id }} etiqueta={t("altas.numero.suspender")} />
          )}
          {numero?.estado === "suspendido" && numero.phoneNumberId && (
            <Accion accion={reactivarElNumero} campos={{ numero_id: numero.id }} etiqueta={t("altas.numero.reactivar")} />
          )}
          {numero && numero.estado !== "baja" && (
            <Accion accion={darDeBajaElNumero} campos={{ numero_id: numero.id }} etiqueta={t("altas.numero.baja")} peligro />
          )}
          {estado === "suspended" && (
            <Accion accion={reactivarElInquilino} campos={{ tenant_id: fila.tenantId }} etiqueta={t("altas.inquilino.reactivar")} />
          )}
          {operable && (
            <Accion accion={suspenderElInquilino} campos={{ tenant_id: fila.tenantId }} etiqueta={t("altas.inquilino.suspender")} peligro />
          )}
        </div>

        {numero?.estado === "pedido" && (
          <form action={conectar} className="mt-3 space-y-2">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{t("altas.conectar.titulo")}</p>
            <p className="text-xs text-slate-500">{t("altas.conectar.ayuda")}</p>
            <input type="hidden" name="numero_id" value={numero.id} />
            <div className="flex flex-wrap gap-2">
              <input
                name="phone_number_id"
                required
                inputMode="numeric"
                pattern="[0-9]{6,20}"
                placeholder={t("altas.numero.phoneNumberId")}
                aria-label={t("altas.numero.phoneNumberId")}
                className={CAMPO}
              />
              <input
                name="waba_id"
                required
                inputMode="numeric"
                pattern="[0-9]{6,20}"
                placeholder={t("altas.numero.waba")}
                aria-label={t("altas.numero.waba")}
                className={CAMPO}
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" name="prueba_de_control" required className="mt-0.5" />
              <span>{t("altas.conectar.confirmo").replace("{correo}", fila.contactEmail ?? "—")}</span>
            </label>
            <button type="submit" className={BOTON}>
              {t("altas.conectar.boton")}
            </button>
          </form>
        )}

        {enPrueba && (
          <form action={extenderLaPrueba} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="tenant_id" value={fila.tenantId} />
            <input
              name="dias"
              type="number"
              required
              min={1}
              max={DIAS_MAXIMOS_DE_PRUEBA}
              placeholder={t("altas.prueba.dias")}
              aria-label={t("altas.prueba.dias")}
              className={`${CAMPO} w-28`}
            />
            <button type="submit" className={BOTON}>
              {t("altas.prueba.extender")}
            </button>
          </form>
        )}

        {operable && (
          <form action={activarElInquilino} className="mt-3 space-y-2">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{t("altas.activar.titulo")}</p>
            <input type="hidden" name="tenant_id" value={fila.tenantId} />
            <div className="flex flex-wrap gap-2">
              <select name="plan" defaultValue="operativo" aria-label={t("altas.activar.plan")} className={CAMPO}>
                {PLANS.map((plan) => (
                  <option key={plan} value={plan}>
                    {nombreDePlan(plan, plan, t)}
                  </option>
                ))}
              </select>
              <input name="cuota" inputMode="decimal" placeholder={t("altas.activar.cuota")} aria-label={t("altas.activar.cuota")} className={`${CAMPO} w-36`} />
              <input name="incluidas" inputMode="numeric" placeholder={t("altas.activar.incluidas")} aria-label={t("altas.activar.incluidas")} className={`${CAMPO} w-36`} />
              <input name="excedente" inputMode="decimal" placeholder={t("altas.activar.excedente")} aria-label={t("altas.activar.excedente")} className={`${CAMPO} w-36`} />
            </div>
            <p className="text-xs text-slate-500">{t("altas.activar.ayuda")}</p>
            <button type="submit" className={BOTON}>
              {t("altas.activar.boton")}
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}
