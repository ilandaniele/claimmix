/**
 * Structured logger for ClaimMix.
 *
 * Outputs structured JSON to stdout/stderr.
 * Vercel captures stdout as structured logs automatically.
 *
 * AC18: DNI and policy numbers must never appear in log output.
 * Use the redactPii() helper (in W2's audit/redact.ts) before logging
 * any user-supplied content.
 *
 * Usage:
 *   import { logger } from '@/lib/observability/logger';
 *   logger.info({ caseId, status }, 'Case status updated');
 *   logger.error({ code: err.code }, 'Route handler error');
 *   const reqLogger = logger.child({ requestId: '123' });
 */

import "server-only";

/** Log level from env, defaults to 'info'. */
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

/** Log levels ordered by severity. */
const LEVELS: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const activeLevel = LEVELS[LOG_LEVEL] ?? LEVELS["info"]!;

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 0) >= activeLevel;
}

function writeEntry(
  level: string,
  bindings: Record<string, unknown>,
  obj: Record<string, unknown>,
  msg: string
): void {
  if (!shouldLog(level)) return;

  const entry = JSON.stringify({
    level,
    time: new Date().toISOString(),
    ...bindings,
    ...obj,
    msg,
  });

  /*
   * Por `console` y no por `process.stderr.write`.
   *
   * Escribía al descriptor directamente, que es un pelo más rápido y por lo
   * demás idéntico: `console.error` termina en stderr igual, y Vercel captura
   * las dos cosas de la misma manera.
   *
   * Lo que NO es idéntico es del lado de los tests. Treinta y tres pruebas
   * comprueban qué se anota y qué no —«el código del error sí, el mensaje que
   * puede traer un DNI adentro no»— y todas espían `console`. Escribiendo por
   * abajo, esos espías se quedan mirando un objeto por el que no pasa nada, y
   * un test así no falla: pasa sin comprobar. Que es exactamente el tipo de
   * verde que este repo viene sacando de todos lados.
   */
  // Cada nivel por su método: un `warn` que sale por `console.error` rompe a
  // quien lo espía por donde corresponde, y encima lo pinta de rojo.
  const salida =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.info;
  salida(entry);
}

export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function makeLogger(bindings: Record<string, unknown>): Logger {
  return {
    debug(obj, msg) {
      writeEntry("debug", bindings, obj, msg);
    },
    info(obj, msg) {
      writeEntry("info", bindings, obj, msg);
    },
    warn(obj, msg) {
      writeEntry("warn", bindings, obj, msg);
    },
    error(obj, msg) {
      writeEntry("error", bindings, obj, msg);
    },
    child(childBindings) {
      return makeLogger({ ...bindings, ...childBindings });
    },
  };
}

/**
 * Application-level structured logger.
 * Use `.child({ caseId })` to create request-scoped child loggers.
 */
export const logger = makeLogger({ service: "claimmix" });
