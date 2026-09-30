/**
 * Email y teléfono en texto libre. Las mismas para el export
 * (`src/server/agents/export.ts`), para `sinDatosDeLaPersona` y para el filtro
 * de resúmenes (`src/core/ai/resumen-seguro.ts`): las capas de tachado
 * comparten la misma regla en vez de mantener cada una la suya.
 *
 * Llevan `g` porque se usan con `replace`. Para preguntar si hay uno, usar
 * `search`: `.test()` sobre una expresión global arrastra `lastIndex`.
 */
export const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
export const PHONE_RE = /(?<!\w)(?:\+?\d[\d .()/-]{7,}\d)(?!\w)/g;
