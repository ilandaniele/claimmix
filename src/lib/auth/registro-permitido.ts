/**
 * Quién puede crearse una cuenta: la lista, en un solo lugar.
 *
 * La lista ya existía, adentro de `provision.ts`, y la política es la de ahí:
 * `SIGNUP_ALLOWED_EMAILS` más `ADMIN_EMAILS`, cerrada cuando no hay ninguna.
 * Este módulo NO inventa otra — la saca de adentro para que la puedan mirar
 * dos capas distintas sin escribirla dos veces.
 *
 * ── Las dos capas, y por qué hacen falta las dos ────────────────────────────
 *
 * `provision.ts` decide, DESPUÉS de crear la cuenta, si le da una fila de
 * perfil. Sin perfil no se resuelve inquilino, así que la cuenta existe y no
 * llega a nada: es un rechazo a prueba de fallas y está bien pensado.
 *
 * Lo que no impide es que la cuenta EXISTA. Alguien puede seguir ocupando una
 * dirección ajena: queda una fila en `user` con ese correo y una contraseña
 * que él eligió. Eso no da acceso a nada, pero es la mitad de la que después
 * hay que cuidarse al vincular Google, y deja basura con la que después alguien
 * tiene que lidiar.
 *
 * Por eso la misma lista se mira además ANTES, en `user.create.before`, donde
 * todavía se puede negar la creación entera.
 *
 * ── Direcciones además de dominios ──────────────────────────────────────────
 *
 * Formato heredado y respetado: una entrada que empieza con `@` es un dominio
 * (`@laaseguradora.com.ar`) y cualquier otra es una dirección exacta. No es un
 * detalle: los seis usuarios de producción son TODOS `@gmail.com`, así que una
 * lista de dominios que los incluya deja entrar al planeta. Con direcciones
 * exactas se cierra de verdad hoy, y el día que la aseguradora tenga dominio
 * propio se cambia por una línea.
 *
 * ── Si no hay ninguna variable ──────────────────────────────────────────────
 *
 * No se registra nadie. Un admin igual da de alta a quien quiera desde
 * `/admin/users` —ver `enAltaDeAdmin`—, así que quedarse sin la variable no
 * deja a nadie sin forma de sumar gente.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Cada entrada: un dominio (`@empresa.com`) o una dirección (`ana@empresa.com`). */
export type Permiso =
  | { tipo: "dominio"; valor: string }
  | { tipo: "direccion"; valor: string };

/**
 * Lee la lista, separada por comas.
 *
 * Tolera espacios y mayúsculas: el correo no distingue mayúsculas en el
 * dominio, y una lista que fallara por eso sería una trampa silenciosa para
 * quien la escribe. El `@` adelante es lo que marca «dominio entero», tal como
 * lo documenta `.env.example`.
 */
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

/**
 * ¿Esta dirección puede crearse una cuenta?
 *
 * Compara en minúsculas y sólo acepta un dominio EXACTO: `empresa.com` no
 * habilita `noempresa.com` ni `empresa.com.ar`. Terminar con
 * `endsWith("empresa.com")` sería la forma corta y dejaría entrar a
 * `malaempresa.com`, que es el error clásico de estas listas.
 */
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

/**
 * La lista configurada: `SIGNUP_ALLOWED_EMAILS` más `ADMIN_EMAILS`.
 *
 * Se lee en cada llamada y no una vez al cargar el módulo, para que cambiarla
 * en Vercel no pida un redeploy.
 */
export function permitidosConfigurados(): Permiso[] {
  return parsearPermitidos(
    [process.env.SIGNUP_ALLOWED_EMAILS, process.env.ADMIN_EMAILS]
      .filter(Boolean)
      .join(",")
  );
}

/**
 * El alta que hace un admin desde `/admin/users`, que no pasa por la lista.
 *
 * La comprobación vive en el gancho `user.create.before` de Better Auth, que es
 * el único punto por el que pasan LOS DOS caminos públicos —el formulario de
 * `/registro` y la primera entrada por Google—. Ese gancho no puede distinguir
 * quién lo disparó, así que el alta de un admin se marca desde afuera.
 *
 * `AsyncLocalStorage` y no una variable de módulo: el servidor atiende pedidos
 * concurrentes, y una bandera global la podría leer el registro de un
 * desconocido que llegó en el mismo instante.
 */
const altaDeAdmin = new AsyncLocalStorage<true>();

/** Corre `fn` marcando que el alta la pide un admin ya autenticado. */
export function enAltaDeAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return altaDeAdmin.run(true, fn);
}

/** ¿Estamos adentro de un alta hecha por un admin? */
export function esAltaDeAdmin(): boolean {
  return altaDeAdmin.getStore() === true;
}

/**
 * La decisión completa, que es la que usa el gancho.
 *
 * @returns `true` si esta dirección puede crear cuenta ahora mismo.
 */
export function altaHabilitada(email: string): boolean {
  if (esAltaDeAdmin()) return true;
  return puedeRegistrarse(email, permitidosConfigurados());
}
