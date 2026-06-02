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

  if (level === "error" || level === "warn") {
    process.stderr.write(entry + "\n");
  } else {
    process.stdout.write(entry + "\n");
  }
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
