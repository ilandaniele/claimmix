/**
 * El mensaje del servidor cuando la IA está pausada a propósito (tope mensual en 0), o `null` si el 429 es otro.
 *
 * El servidor lo manda ya en el idioma de la cuenta y marcado con `details.frenada`; el cliente sólo lo
 * muestra, así no suma textos al diccionario del navegador. Cualquier otro 429 —el cupo por hora, un tope
 * diario o el del mes— sigue con el texto traducido de cada pantalla: su `message` es prosa interna, con cifras.
 */
export async function mensajeDeLaIaFrenada(res: Response): Promise<string | null> {
  try {
    const cuerpo = (await res.json()) as {
      error?: { code?: string; message?: string; details?: { frenada?: boolean } };
    } | null;
    const error = cuerpo?.error;
    return error?.code === "AI_BUDGET_EXCEEDED" && error.details?.frenada === true ? (error.message ?? null) : null;
  } catch {
    return null;
  }
}
