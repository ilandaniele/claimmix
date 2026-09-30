import { FormularioApi } from "@/components/FormularioApi";
import { BOTON, CAMPO, ETIQUETA } from "@/components/estilos-de-formulario";
import { ESTADOS_DE_POLIZA, RAMOS_DE_POLIZA } from "@/core/padron/campos";
import type { TranslationKey } from "@/lib/i18n";
import { conTopes } from "@/server/padron/lineas";

/**
 * Los formularios del padrón (B16): importar un CSV, y dar de alta o editar a
 * mano un cliente y sus pólizas. Todos son de servidor; sólo `FormularioApi`
 * viaja al navegador. Quién ve estos paneles lo decide la página: la API vuelve
 * a chequear el rol de todos modos.
 */

type Traducir = (clave: TranslationKey) => string;

const CONTENEDOR = "rounded-lg border border-slate-200 p-3 dark:border-slate-800";
const ANCHO = `${CAMPO} block w-full`;

export function ImportarPadron({ t }: { t: Traducir }) {
  return (
    <details className={CONTENEDOR}>
      <summary className="cursor-pointer text-sm font-medium">{t("padron.importar.titulo")}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-slate-500">{conTopes(t("padron.importar.ayuda"))}</p>
        <p className="text-xs text-slate-500">{t("padron.importar.columnas")}</p>
        <FormularioApi
          action="/api/padron/vista-previa"
          method="POST"
          multipart
          okTexto={t("padron.importar.ok")}
          errorTexto={t("padron.importar.error")}
          className="space-y-3"
        >
          <label className={ETIQUETA}>
            {t("padron.importar.archivo")}
            <input type="file" name="archivo" required accept=".csv,text/csv,text/plain" className={ANCHO} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" formAction="/api/padron/vista-previa" className={`${CAMPO} font-medium`}>
              {t("padron.importar.vistaPrevia")}
            </button>
            <button type="submit" formAction="/api/padron/importar" className={BOTON}>
              {t("padron.importar.confirmar")}
            </button>
          </div>
        </FormularioApi>
      </div>
    </details>
  );
}

export interface ClienteEditable {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  birth_date: string | null;
  address: string | null;
}

/** Alta (sin `cliente`) o edición (con él). El DNI sólo se pide en el alta: después no cambia. */
export function FormularioDeCliente({ t, cliente }: { t: Traducir; cliente?: ClienteEditable }) {
  return (
    <FormularioApi
      action={cliente ? `/api/customers/${cliente.id}` : "/api/customers"}
      method={cliente ? "PATCH" : "POST"}
      okTexto={t(cliente ? "padron.cliente.guardado" : "padron.cliente.creado")}
      errorTexto={t("padron.cliente.error")}
      reiniciar={!cliente}
      className="space-y-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={ETIQUETA}>
          {t("padron.cliente.nombre")}
          <input name="nombre" required maxLength={120} defaultValue={cliente?.full_name} className={ANCHO} />
        </label>
        {!cliente && (
          <label className={ETIQUETA}>
            {t("padron.cliente.dni")}
            <input name="dni" required inputMode="numeric" maxLength={14} className={`${ANCHO} font-mono`} />
            <span className="block font-normal">{t("padron.cliente.dniAyuda")}</span>
          </label>
        )}
        <label className={ETIQUETA}>
          {t("padron.cliente.email")}
          <input name="email" type="email" maxLength={254} defaultValue={cliente?.email ?? ""} className={ANCHO} />
        </label>
        <label className={ETIQUETA}>
          {t("padron.cliente.telefono")}
          <input name="telefono" type="tel" maxLength={40} defaultValue={cliente?.phone ?? ""} className={ANCHO} />
        </label>
        <label className={ETIQUETA}>
          {t("padron.cliente.nacimiento")}
          <input name="nacimiento" type="date" defaultValue={cliente?.birth_date ?? ""} className={ANCHO} />
        </label>
        <label className={ETIQUETA}>
          {t("padron.cliente.direccion")}
          <input name="direccion" maxLength={200} defaultValue={cliente?.address ?? ""} className={ANCHO} />
        </label>
      </div>
      {cliente && <p className="text-xs text-slate-500">{t("padron.cliente.vaciarAyuda")}</p>}
      <button type="submit" className={BOTON}>
        {t(cliente ? "padron.cliente.guardar" : "padron.cliente.crear")}
      </button>
    </FormularioApi>
  );
}

export interface PolizaEditable {
  id: string;
  policy_number: string;
  policy_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  premium_amount: string | null;
}

/** Alta (con `clienteId`) o edición (con `poliza`). El número y el titular sólo se eligen en el alta. */
export function FormularioDePoliza({
  t,
  clienteId,
  poliza,
}: {
  t: Traducir;
  clienteId?: string;
  poliza?: PolizaEditable;
}) {
  return (
    <FormularioApi
      action={poliza ? `/api/policies/${poliza.id}` : "/api/policies"}
      method={poliza ? "PATCH" : "POST"}
      okTexto={t(poliza ? "padron.poliza.guardada" : "padron.poliza.creada")}
      errorTexto={t("padron.poliza.error")}
      reiniciar={!poliza}
      className="space-y-3"
    >
      {clienteId && <input type="hidden" name="customer_id" value={clienteId} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {!poliza && (
          <label className={ETIQUETA}>
            {t("padron.poliza.numero")}
            <input name="numero" required maxLength={60} className={`${ANCHO} font-mono`} />
          </label>
        )}
        <label className={ETIQUETA}>
          {t("padron.poliza.ramo")}
          <select name="ramo" defaultValue={poliza?.policy_type ?? ""} className={ANCHO}>
            {!poliza && <option value="">{t("padron.poliza.sinDefinir")}</option>}
            {RAMOS_DE_POLIZA.map((r) => (
              <option key={r} value={r}>
                {t(`clientes.policyType.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={ETIQUETA}>
          {t("padron.poliza.estado")}
          <select name="estado" defaultValue={poliza?.status ?? ""} className={ANCHO}>
            {!poliza && <option value="">{t("padron.poliza.sinDefinir")}</option>}
            {ESTADOS_DE_POLIZA.map((e) => (
              <option key={e} value={e}>
                {t(`clientes.policyStatus.${e}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={ETIQUETA}>
          {t("padron.poliza.prima")}
          <input name="prima" inputMode="decimal" maxLength={20} defaultValue={poliza?.premium_amount ?? ""} className={ANCHO} />
        </label>
        <label className={ETIQUETA}>
          {t("padron.poliza.desde")}
          <input name="desde" type="date" defaultValue={poliza?.start_date ?? ""} className={ANCHO} />
        </label>
        <label className={ETIQUETA}>
          {t("padron.poliza.hasta")}
          <input name="hasta" type="date" defaultValue={poliza?.end_date ?? ""} className={ANCHO} />
        </label>
      </div>
      <p className="text-xs text-slate-500">{t("padron.poliza.vigenciaAyuda")}</p>
      <button type="submit" className={BOTON}>
        {t(poliza ? "padron.poliza.guardar" : "padron.poliza.crear")}
      </button>
    </FormularioApi>
  );
}
