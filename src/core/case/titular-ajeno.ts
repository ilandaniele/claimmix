/**
 * ¿Quien escribe es otra persona que el titular de la póliza que dio?
 *
 * El worker ya lo sabe cuando busca al cliente: el padrón encontró la póliza y
 * marcó que ni el nombre ni el DNI coinciden. Que la derivación dependiera de
 * que el modelo lo notara la hacía variar entre corridas, igual que la póliza
 * vencida en #187.
 */

import {
  MINIMO_DNI,
  mismoNombre,
  normalizarDni,
  normalizarNombre,
  sirveParaBuscar,
} from "@/core/matching/normalizar";

/** Lo que dijo la persona, ya canonizado y sin lo que llegó por el canal. */
interface LoQueDijo {
  full_name?: string | null;
  dni?: string | null;
}

/** Lo mínimo de `CustomerMatch` para decidir. */
interface TitularEncontrado {
  matchType: string;
  conflictsWithExtracted: readonly string[];
  storedValues: Readonly<Record<string, string>>;
}

/*
 * Las dos cosas, y no una: un nombre distinto con el mismo DNI es un apodo o
 * un error de tipeo, y un DNI distinto con el mismo nombre puede ser un padre
 * y un hijo homónimos. Eso lo sigue mirando el modelo.
 *
 * Además de comparar, pide que el buscador haya marcado los dos conflictos: el
 * único mensaje de esa vuelta es el pedido de confirmación, y sin esas marcas
 * no sale con los dos valores que la persona necesita para contestar.
 */
function noEsEsaPersona(dijo: LoQueDijo, titular: TitularEncontrado): boolean {
  const conflictos = titular.conflictsWithExtracted;
  if (!conflictos.includes("dni") || !conflictos.includes("full_name")) return false;

  const dniDicho = normalizarDni(dijo.dni ?? "");
  const dniDelPadron = normalizarDni(titular.storedValues.dni ?? "");
  if (!sirveParaBuscar(dniDicho, MINIMO_DNI) || !sirveParaBuscar(dniDelPadron, MINIMO_DNI)) {
    return false;
  }
  if (dniDicho === dniDelPadron) return false;

  const nombreDicho = dijo.full_name ?? "";
  const nombreDelPadron = titular.storedValues.full_name ?? "";
  if (!normalizarNombre(nombreDicho) || !normalizarNombre(nombreDelPadron)) return false;

  return !mismoNombre(nombreDicho, nombreDelPadron);
}

/*
 * Sólo las coincidencias por número de póliza: una por DNI encuentra a quien
 * escribe, no al titular de lo que reclama. Y todas tienen que ser de otro:
 * si una de las pólizas encontradas es suya, no hay nada que derivar.
 */
export function esTitularAjeno(
  dijo: LoQueDijo,
  encontrados: readonly TitularEncontrado[]
): boolean {
  const porPoliza = encontrados.filter((m) => m.matchType === "policy_number");
  return porPoliza.length > 0 && porPoliza.every((m) => noEsEsaPersona(dijo, m));
}
