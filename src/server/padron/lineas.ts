/**
 * Lo que una importación del padrón le cuenta a quien la pidió, ya redactado.
 *
 * El navegador no carga el diccionario: `FormularioApi` muestra `resumen` línea
 * por línea, así que las rutas devuelven las frases hechas en el idioma de la
 * cuenta. Esto arma esas frases desde un `t` de servidor, sin tocar la base.
 */

import { MAX_BYTES_DEL_ARCHIVO, MAX_COLUMNAS, MAX_FILAS_DE_DATOS } from "@/core/padron/csv";
import type { ErrorDeFila } from "@/core/padron/filas";
import type { PlanPadron } from "@/core/padron/plan";
import type { TranslationKey } from "@/lib/i18n";

type Traducir = (clave: TranslationKey) => string;

/** Los topes que las frases del padrón nombran: no se copian en el diccionario. */
export function conTopes(texto: string): string {
  return texto
    .replace("{kb}", String(MAX_BYTES_DEL_ARCHIVO / 1024))
    .replace("{filas}", String(MAX_FILAS_DE_DATOS))
    .replace("{columnas}", String(MAX_COLUMNAS));
}

/** El motivo de un rechazo, sea del archivo, de una fila o del alta a mano. */
export function motivoDe(t: Traducir, codigo: string): string {
  return conTopes(t(`padron.error.${codigo}` as TranslationKey));
}

interface Datos {
  aplicado: boolean;
  resumen: PlanPadron["resumen"];
  errores: ErrorDeFila[];
  erroresTotal: number;
  ignoradas: string[];
}

const conteo = (t: Traducir, clave: TranslationKey, c: { altas: number; cambios: number; iguales: number }) =>
  t(clave)
    .replace("{altas}", String(c.altas))
    .replace("{cambios}", String(c.cambios))
    .replace("{iguales}", String(c.iguales));

/** Las líneas de una vista previa o de una importación: el veredicto, las cuentas y cada error. */
export function lineasDelPadron(t: Traducir, d: Datos): string[] {
  const { clientes, polizas } = d.resumen;
  const hayCambios = clientes.altas + clientes.cambios + polizas.altas + polizas.cambios > 0;
  const titulo: TranslationKey =
    d.erroresTotal > 0
      ? "padron.resultado.conErrores"
      : !hayCambios
        ? "padron.resultado.sinCambios"
        : d.aplicado
          ? "padron.resultado.aplicado"
          : "padron.resultado.vistaPrevia";

  const lineas = [t(titulo)];
  // Con errores no se importa nada: las cuentas del plan serían de algo que no ocurre.
  if (d.erroresTotal === 0) {
    lineas.push(conteo(t, "padron.conteo.clientes", clientes), conteo(t, "padron.conteo.polizas", polizas));
  }
  if (d.ignoradas.length) lineas.push(t("padron.ignoradas").replace("{columnas}", d.ignoradas.join(", ")));
  for (const e of d.errores) {
    lineas.push(t("padron.errorEnFila").replace("{fila}", String(e.fila)).replace("{motivo}", motivoDe(t, e.codigo)));
  }
  if (d.erroresTotal > d.errores.length) {
    lineas.push(t("padron.masErrores").replace("{n}", String(d.erroresTotal - d.errores.length)));
  }
  return lineas;
}
