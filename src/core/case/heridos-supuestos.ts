/**
 * «No hubo personas lastimadas», dicho por nadie.
 *
 * El ensayo del 23/09 le propuso «• ¿Hubo personas lastimadas?: no» a quien
 * nunca habló de heridos, y un «ok» lo dejó confirmado. El modelo leía el
 * silencio como «none». Esto borra ese negativo cuando lo que escribió la
 * persona no nombra heridos, y deja la pregunta abierta, sin valor.
 *
 * Un negativo supuesto sólo se borra: si el léxico no reconoce cómo lo dijo,
 * cuesta una pregunta de más, nunca tapa una herida, y la gravedad y la
 * derivación no se tocan. Lo que sí las toca es la respuesta a la pregunta
 * abierta: el modelo no ve que se la hicimos, así que un «No» o un «Sí» sueltos
 * no le dicen nada, y se leen acá.
 */

import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import { valorLegible } from "@/core/mensajes/valor-legible";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";

// «lastim(?!a\b)» deja afuera «qué lastima», que no habla de nadie. «víctima»
// sola no: «fui víctima de un robo» no dice nada de heridos.
const HERIDOS = new RegExp(
  [
    String.raw`\bherid|\bhiri|\blastim(?!a\b)|\blesi[oó]n|\blesionad|\biles[oa]s?\b`,
    String.raw`\b(?:sin|no hubo) v[ií]ctimas\b|\btod[oa]s(?: estamos| est[aá]n)? bien\b`,
    String.raw`\bno (?:nos|me) pas[oó] nada\b|\bs[oó]lo da[ñn]os materiales\b`,
    String.raw`\binjur|\bhurt\b|\bwounded\b|\bevery(?:one|body)(?:'s| is| was)? (?:fine|ok|okay|safe)\b`,
  ].join("|"),
  "i"
);
// Lo que `valorLegible` no traduce porque el modelo lo escribió en palabras.
const NEGATIVO_EN_PALABRAS = /^(?:ningun[oa]?|ningún|nadie|sin (?:herid|lastimad|lesionad)\w*|no hubo\b.*)$/i;
const HERIDOS_KEY = "hay_heridos";

/*
 * Una respuesta suelta, trozo por trozo entre signos. Cada trozo tiene que ser
 * entero un «no» o algo que no dice nada: «No, pero mi hijo se golpeó» o
 * «No, sólo mi hijo» no son un «no». Lo que sigue a un «Saludos» es la firma.
 */
const NO_SUELTO = new RegExp(
  "^(?:(?:por suerte|gracias a dios) )?(?:" +
    [
      "no|nop|nope|none|nobody|no one|nadie|nada|para nada|ningun[oa]?|ningún",
      "no hubo(?: nadie| heridos| lastimados| v[ií]ctimas)?|sin (?:herid|lastimad|lesionad|v[ií]ctim)\\p{L}*",
      "nadie (?:sali[oó] |result[oó] |se )?(?:herid|lastim|hiri|golpe)\\p{L}*",
      "(?:estamos |est[aá]n )?tod[oa]s(?: estamos| est[aá]n)? bien|no (?:nos|me) pas[oó] nada",
      "s[oó]lo (?:(?:el|la|lo|los|las|mi) )?(?:auto|coche|moto|camioneta|veh[ií]culo|cami[oó]n|da[ñn]os?(?: materiales)?|material)",
      "no injuries|nobody (?:was |got )?hurt|every(?:one|body)(?:'s| is| was)? (?:fine|ok|okay|safe)",
    ].join("|") +
    ")$",
  "iu"
);
const NEUTRO =
  /^(?:hola|buenas(?: tardes| noches)?|buen(?:os)? d[ií]as?|ok|dale|(?:muchas )?gracias(?: a dios)?|por suerte|menos mal)$/i;
const CIERRE = /^(?:(?:un |muchos )?saludos?|slds|atte|atentamente|cordialmente|(?:un )?abrazo|(?:best )?regards)$/i;
const SI_SUELTO = /^(?:s[ií]|sip|yes|yeah|yep|s[ií] hubo|hubo)$/i;
// La firma sin «Saludos» arriba, de abajo hacia arriba: teléfono, mail, «Enviado
// desde…» y el nombre. Un nombre son dos a cuatro palabras con mayúscula que no
// arrancan como una frase ni nombran heridos: «Sólo Mi Hijo» no es una firma.
const CONTACTO =
  /^(?:(?:tel(?:[eé]fono)?|cel(?:ular)?|m[oó]vil|whats?app|wsp)\.?:?\s*)?[+\d][\d\s().-]{5,}$|^\S+@\S+\.\S+$|^(?:enviado desde|sent from)\b/i;
const NOMBRE = /^\p{Lu}[\p{L}'.]*(?:\s+\p{Lu}[\p{L}'.]*){1,3}$/u;
const NO_ES_NOMBRE =
  /(?:^|\s)(?:mis?|sus?|tus?|el|la|los|las|una?|nuestr\p{L}*|s[oó]lo|nadie|no|s[ií]|tod[oa]s|bien)(?=\s|$)/iu;
// «[Imagen adjunta sin texto]»: lo que queda de una foto sin epígrafe.
const ADJUNTO = /\[[^\]]*\]/g;

export type RespuestaAHeridos = "sí" | "no" | null;

/** Si lo que escribió la persona dice algo, lo que sea, sobre heridos. */
export function hablaDeHeridos(texto: string): boolean {
  return HERIDOS.test(texto);
}

const esDeHeridos = (clave: string): boolean => canonicalFieldKey(clave) === HERIDOS_KEY;

/**
 * Lo que contestó a «¿Hubo personas lastimadas?» cuando fue lo único que le
 * preguntamos, y abierto. Con más cosas en la lista, un «No» o un «Sí» no dicen
 * a cuál; y si se preguntó con un valor adentro, «Sí» es «sí, es correcto que
 * no», y eso lo cierra la confirmación, no esto.
 *
 * Toma todo lo que escribió desde el pedido, mensaje por mensaje: un «No»
 * seguido de un «gracias» o de una foto sigue siendo un «no».
 */
export function respuestaAHeridos(
  preguntadas: readonly string[],
  texto: string | readonly string[] | null | undefined,
  propuestos: Readonly<Record<string, string>> = {}
): RespuestaAHeridos {
  if (preguntadas.length === 0 || !preguntadas.every(esDeHeridos)) return null;
  if (Object.entries(propuestos).some(([k, v]) => esDeHeridos(k) && leido(v) !== null)) return null;

  const dichos = [texto ?? ""].flat().flatMap(loDicho);
  if (dichos.length === 0) return null;

  if (dichos.every((t) => NO_SUELTO.test(t))) return "no";
  if (SI_SUELTO.test(dichos[0]) && !dichos.some((t) => NO_SUELTO.test(t))) return "sí";
  return null;
}

/** Los trozos de un mensaje que dicen algo, sin saludo, firma ni adjuntos. */
function loDicho(mensaje: string): string[] {
  const lineas = mensaje.replace(ADJUNTO, "").split("\n").map((l) => l.trim()).filter(Boolean);
  while (lineas.length > 1 && esFirma(lineas[lineas.length - 1])) lineas.pop();

  const trozos = lineas
    .join("\n")
    .toLowerCase()
    .split(/[,.;:!?¡¿\n]+/)
    .map((t) => t.replace(/[^\p{L}\s']/gu, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const firma = trozos.findIndex((t) => CIERRE.test(t));
  return (firma < 0 ? trozos : trozos.slice(0, firma)).filter((t) => !NEUTRO.test(t));
}

function esFirma(linea: string): boolean {
  if (CONTACTO.test(linea)) return true;
  return NOMBRE.test(linea) && !NO_ES_NOMBRE.test(linea) && !hablaDeHeridos(linea);
}

const leido = (valor: string | null | undefined): string | null =>
  valorLegible(HERIDOS_KEY, (valor ?? "").trim(), "");

function esNegativo(valor: string | null | undefined): boolean {
  return leido(valor) === "no" || NEGATIVO_EN_PALABRAS.test((valor ?? "").trim());
}

/**
 * El mismo reclamo sin el «no hubo heridos» que la persona nunca dijo, o con lo
 * que contestó a la pregunta abierta (`respuestaAHeridos`).
 */
export function sinHeridosSupuestos(
  claim: ExtractedClaim,
  texto: string,
  respuesta: RespuestaAHeridos = null
): ExtractedClaim {
  if (respuesta) return conLaRespuesta(claim, respuesta);
  if (hablaDeHeridos(texto)) return claim;

  const fields = claim.fields.filter(
    (f) => !(esDeHeridos(f.field_key) && esNegativo(f.field_value))
  );
  const borrados = fields.length < claim.fields.length;
  const severidadSupuesta = esNegativo(claim.injury_severity);
  if (!borrados && !severidadSupuesta) return claim;

  // Sin valor, la clave pendiente sale como pregunta abierta y no como «¿…?: no».
  const pendientes = claim.fields_pending_confirmation;
  return {
    ...claim,
    fields,
    fields_pending_confirmation:
      borrados && !pendientes.some(esDeHeridos) ? [...pendientes, HERIDOS_KEY] : pendientes,
    injury_severity: severidadSupuesta ? null : claim.injury_severity,
  };
}

/**
 * Si el reclamo dice que alguien se lastimó.
 *
 * No alcanza con `injury_severity`: el «Sí» a la pregunta abierta deriva el
 * caso y la deja en null, y sólo `hay_heridos` lo dice. La severidad del caso
 * tampoco: habla del siniestro, no de las personas.
 */
export function hayHeridos(claim: Pick<ExtractedClaim, "injury_severity" | "fields">): boolean {
  return (
    leido(claim.injury_severity) === "sí" ||
    claim.fields.some((f) => esDeHeridos(f.field_key) && leido(f.field_value) === "sí")
  );
}

function conLaRespuesta(claim: ExtractedClaim, respuesta: "sí" | "no"): ExtractedClaim {
  const herido = hayHeridos(claim);
  // Un «no» no tapa una herida que el modelo leyó en otra parte de la charla.
  if (respuesta === "no" && herido) return claim;

  const conValor: ExtractedClaim = {
    ...claim,
    fields: [
      ...claim.fields.filter((f) => !esDeHeridos(f.field_key)),
      { field_key: HERIDOS_KEY, field_value: respuesta, confidence: 0.95, source: "ai" },
    ],
    fields_pending_confirmation: claim.fields_pending_confirmation.filter((k) => !esDeHeridos(k)),
    missing_fields: claim.missing_fields.filter((k) => !esDeHeridos(k)),
  };
  if (respuesta === "no") return { ...conValor, injury_severity: "none" };

  // Qué tan grave no lo dijo: la gravedad del caso sube y el grado queda sin saber.
  return {
    ...conValor,
    injury_severity: herido ? claim.injury_severity : null,
    severity: claim.severity === "critical" ? "critical" : "high",
    requires_specialist: true,
  };
}
