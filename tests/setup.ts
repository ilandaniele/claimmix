/**
 * Vitest global test setup.
 * Imported via vitest.config.ts → test.setupFiles.
 *
 * vitest.config.ts sets globals: true, which injects vi, describe, it, expect, etc.
 * We add @testing-library/jest-dom matchers for DOM assertions.
 */

import "@testing-library/jest-dom";

/*
 * El secreto de sesión, para los tests que importan `@/lib/auth`.
 *
 * Desde que falta romper en vez de degradar, ese módulo tira al cargarse si la
 * variable no está — que es el punto: sin ella, better-auth firma las sesiones
 * con un secreto publicado en su propio código.
 *
 * Acá se pone uno de mentira. No es aflojar la guarda: es que el entorno de
 * pruebas cumpla el mismo requisito que producción, en vez de que la guarda se
 * ablande para que los tests pasen.
 */
process.env.BETTER_AUTH_SECRET ||= "secreto-de-prueba-que-no-firma-nada-real";
