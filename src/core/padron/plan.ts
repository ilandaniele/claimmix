/**
 * Qué cambia una importación del padrón (B16): altas, modificaciones y errores,
 * calculado sin tocar la base. El servidor le da lo que ya existe y escribe lo
 * que este plan devuelve; una vista previa y una importación corren el mismo
 * plan, así lo que se ve es lo que se aplica.
 *
 * Reglas:
 * - Un cliente se reconoce por DNI y una póliza por su número, ambos normalizados
 *   (sólo dígitos; sin espacios y en mayúsculas). Los mapas de `Existentes` van
 *   con esa clave, pero cada fila guarda el valor tal cual está en la base: el
 *   plan lo devuelve así para que el ON CONFLICT, que compara el texto crudo,
 *   caiga sobre la fila que ya existe y no abra otra.
 * - Una celda vacía deja el dato como estaba; una llena lo reemplaza.
 * - Dos filas del mismo DNI que se contradicen no se mezclan: la segunda es un
 *   error.
 * - Una póliza no cambia de titular por importación.
 */

import { mismoNombre, normalizarTelefono } from "@/core/matching/normalizar";

import type { ErrorDeFila, FilaPadron } from "./filas";

export interface ClienteExistente {
  id: string;
  dni: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  birth_date: string | null;
  address: string | null;
}

export interface PolizaExistente {
  id: string;
  customer_id: string;
  policy_number: string;
  policy_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  premium_amount: string | null;
}

/** Los dos mapas van por clave normalizada: `normalizarDni` y `normalizarNumeroPoliza`. */
export interface Existentes {
  clientes: Map<string, ClienteExistente>;
  polizas: Map<string, PolizaExistente>;
}

export type ClienteAEscribir = ClienteExistente;
export type PolizaAEscribir = Omit<PolizaExistente, "id">;

export interface Conteo {
  altas: number;
  cambios: number;
  iguales: number;
}

export interface PlanPadron {
  clientes: ClienteAEscribir[];
  polizas: PolizaAEscribir[];
  resumen: { clientes: Conteo; polizas: Conteo };
  errores: ErrorDeFila[];
}

const CAMPOS_DEL_CLIENTE = [
  ["nombre", "full_name"],
  ["email", "email"],
  ["telefono", "phone"],
  ["nacimiento", "birth_date"],
  ["direccion", "address"],
] as const;

/** Dos formas de escribir lo mismo no son una contradicción. */
function coinciden(campo: string, a: string, b: string): boolean {
  if (campo === "nombre") return mismoNombre(a, b);
  if (campo === "telefono") return normalizarTelefono(a) === normalizarTelefono(b);
  return a === b;
}

interface Acumulado {
  cliente: ClienteAEscribir;
  existente: ClienteExistente | undefined;
  aportes: Map<string, string>;
  primeraFila: number;
  numeros: string[];
  /** Filas que entraron al plan: un DNI cuyas filas fallaron todas no aporta nada. */
  aceptadas: number;
}

export function planearPadron(filas: FilaPadron[], existentes: Existentes, nuevoId: () => string): PlanPadron {
  const errores: ErrorDeFila[] = [];
  const acumulados = new Map<string, Acumulado>();
  const polizas = new Map<string, PolizaAEscribir>();

  for (const f of filas) {
    let acc = acumulados.get(f.dni);
    if (!acc) {
      const existente = existentes.clientes.get(f.dni);
      acc = {
        cliente: existente
          ? { ...existente }
          : { id: nuevoId(), dni: f.dni, full_name: "", email: null, phone: null, birth_date: null, address: null },
        existente,
        aportes: new Map(),
        primeraFila: f.fila,
        numeros: [],
        aceptadas: 0,
      };
      acumulados.set(f.dni, acc);
    }

    const contradice = CAMPOS_DEL_CLIENTE.some(([k]) => {
      const previo = acc.aportes.get(k);
      return f[k] !== undefined && previo !== undefined && !coinciden(k, previo, f[k]);
    });
    if (contradice) {
      errores.push({ fila: f.fila, codigo: "cliente_contradictorio" });
      continue;
    }

    const p = f.poliza;
    let poliza: PolizaAEscribir | undefined;
    if (p) {
      const previa = existentes.polizas.get(p.numero);
      if (polizas.has(p.numero)) {
        errores.push({ fila: f.fila, codigo: "poliza_repetida" });
        continue;
      }
      if (previa && previa.customer_id !== acc.cliente.id) {
        errores.push({ fila: f.fila, codigo: "poliza_de_otro_titular" });
        continue;
      }
      poliza = {
        customer_id: acc.cliente.id,
        policy_number: previa?.policy_number ?? p.numero,
        policy_type: p.ramo ?? previa?.policy_type ?? "other",
        status: p.estado ?? previa?.status ?? "active",
        start_date: p.desde ?? previa?.start_date ?? null,
        end_date: p.hasta ?? previa?.end_date ?? null,
        premium_amount: p.prima ?? previa?.premium_amount ?? null,
      };
      if (poliza.start_date && poliza.end_date && poliza.start_date > poliza.end_date) {
        errores.push({ fila: f.fila, codigo: "vigencia_invertida" });
        continue;
      }
    }

    acc.aceptadas++;
    for (const [k, columna] of CAMPOS_DEL_CLIENTE) {
      const v = f[k];
      if (v === undefined) continue;
      acc.aportes.set(k, v);
      acc.cliente[columna] = v;
    }
    if (poliza && p) {
      polizas.set(p.numero, poliza);
      acc.numeros.push(p.numero);
    }
  }

  const resumen = {
    clientes: { altas: 0, cambios: 0, iguales: 0 },
    polizas: { altas: 0, cambios: 0, iguales: 0 },
  };
  const clientes: ClienteAEscribir[] = [];
  for (const acc of acumulados.values()) {
    if (acc.aceptadas === 0) continue;
    if (!acc.existente && !acc.cliente.full_name) {
      errores.push({ fila: acc.primeraFila, codigo: "nombre_requerido" });
      for (const n of acc.numeros) polizas.delete(n);
      continue;
    }
    const e = acc.existente;
    const cambio = !e || CAMPOS_DEL_CLIENTE.some(([, c]) => acc.cliente[c] !== e[c]);
    if (!cambio) resumen.clientes.iguales++;
    else {
      clientes.push(acc.cliente);
      resumen.clientes[e ? "cambios" : "altas"]++;
    }
  }

  const aEscribir: PolizaAEscribir[] = [];
  for (const [numero, p] of polizas) {
    const e = existentes.polizas.get(numero);
    const cambio =
      !e ||
      p.policy_type !== e.policy_type ||
      p.status !== e.status ||
      p.start_date !== e.start_date ||
      p.end_date !== e.end_date ||
      p.premium_amount !== e.premium_amount;
    if (!cambio) resumen.polizas.iguales++;
    else {
      aEscribir.push(p);
      resumen.polizas[e ? "cambios" : "altas"]++;
    }
  }

  errores.sort((a, b) => a.fila - b.fila);
  return { clientes, polizas: aEscribir, resumen, errores };
}
