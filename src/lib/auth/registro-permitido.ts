// Who may create an account: SIGNUP_ALLOWED_EMAILS + ADMIN_EMAILS.
// Entry starting with "@" = whole domain; anything else = exact address.
// No list → nobody. Admins bypass via `enAltaDeAdmin`.
import { AsyncLocalStorage } from "node:async_hooks";

export type Permiso =
  | { tipo: "dominio"; valor: string }
  | { tipo: "direccion"; valor: string };

export function parsearPermitidos(crudo: string | undefined): Permiso[] {
  if (!crudo) return [];
  return crudo
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((entrada) =>
      entrada.startsWith("@")
        ? ({ tipo: "dominio", valor: entrada.slice(1) } as const)
        : ({ tipo: "direccion", valor: entrada } as const)
    )
    .filter((p) => p.valor.length > 0);
}

export function puedeRegistrarse(email: string, permitidos: Permiso[]): boolean {
  if (permitidos.length === 0) return false;

  const dir = email.trim().toLowerCase();
  const arroba = dir.lastIndexOf("@");
  if (arroba <= 0 || arroba === dir.length - 1) return false;
  const dominio = dir.slice(arroba + 1);

  return permitidos.some((p) =>
    p.tipo === "direccion" ? p.valor === dir : p.valor === dominio
  );
}

export function permitidosConfigurados(): Permiso[] {
  return parsearPermitidos(
    [process.env.SIGNUP_ALLOWED_EMAILS, process.env.ADMIN_EMAILS]
      .filter(Boolean)
      .join(",")
  );
}

// AsyncLocalStorage, not a module flag: concurrent requests must not share it.
const altaDeAdmin = new AsyncLocalStorage<true>();

export function enAltaDeAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return altaDeAdmin.run(true, fn);
}

export function esAltaDeAdmin(): boolean {
  return altaDeAdmin.getStore() === true;
}

export function altaHabilitada(email: string): boolean {
  if (esAltaDeAdmin()) return true;
  return puedeRegistrarse(email, permitidosConfigurados());
}
