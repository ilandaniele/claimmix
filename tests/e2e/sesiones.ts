/**
 * Dónde quedan guardadas las sesiones que arma `auth.setup.ts`.
 *
 * Vive en su propio archivo y no adentro del setup porque Playwright se niega a
 * que un spec importe otro archivo de test: `auth.setup.ts` es un test —corre
 * como proyecto `setup`— así que importarle una constante desde un spec falla
 * con «should not import test file». Las rutas son datos, no tests, y acá no
 * molestan a nadie.
 */
import path from "node:path";

/** La sesión de un analista: el rol del que usa el producto todo el día. */
export const SESION_ANALISTA = path.resolve("tests/e2e/.sesiones/analista.json");

/** La de un admin, que ve cosas que el analista no. */
export const SESION_ADMIN = path.resolve("tests/e2e/.sesiones/admin.json");
