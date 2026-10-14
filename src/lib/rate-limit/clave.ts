/**
 * La única forma de escribir la clave de un cupo.
 *
 * Dos formas de escribir la misma clave son dos cupos: el login por formulario
 * contaba en `signin:…` y el mismo login por la API en `auth:in:…`, así que un
 * atacante tenía los dos topes enteros. Todas las claves salen de acá.
 *
 * Sin imports a propósito: la usan tests puros y módulos de `src/app` sin
 * arrastrar la cadena de `server-only` de `./index`.
 */
export type AmbitoDeCupo =
  | "user"
  | "auth:in"
  | "auth:up"
  | "auth:reset"
  | "auth:sso"
  | "auth:ip"
  | "alta:ip"
  | "alta:correo-ip"
  | "alta:aviso80"
  | "alta:correos"
  | "alta:destinatario"
  | "alta:aviso-numero"
  | "usuarios:inquilino"
  | "ia:prueba"
  | "wa:plantilla"
  | "wa:codigo"
  | "wa:codigo-ip"
  | "wa:codigos"
  | "wa:alta-numero"
  | "wa:altas-numero"
  | "wa:verificar"
  | "wa:registrar"
  | "wa:es"
  | "wa:es:inicio"
  | "wa:es:seguir"
  | "wa:app"
  | "wa:app:inicio"
  | "wa:app:estado"
  | "wa:firma"
  | "wa:firma:ip"
  | "wa:firma:ruta"
  | "wa:firma:revision"
  | "meta:borrado"
  | "demo-public"
  | "denuncia-web"
  | "denuncia-slug"
  | "denuncia-mail"
  | "denuncia-slug-dia"
  | "email"
  | "aviso-presupuesto"
  | "aviso-desvios"
  | "batch-simulate"
  | "re-analyze"
  | "whatsapp"
  | "core-api"
  | "aviso-tardio"
  | "clasificacion-tardia"
  | "condiciones-poliza"
  | "subida-condiciones"
  | "lectura-presupuesto"
  | "lectura-reclamo"
  | "asistente-caso"
  | "revision-de-desvios"
  | "purga-y-retencion";

/** El prefijo de IPv6 con el que se cuenta: un /64 es lo que un proveedor le da a una sola máquina. */
const PREFIJO_IPV6 = 64;
/** El alta y el pedido de código son los cupos más caros de regalar: se cuentan por /56, que es lo que se le da a un sitio entero. */
const PREFIJO_POR_AMBITO: Partial<Record<AmbitoDeCupo, number>> = { "alta:ip": 56, "alta:correo-ip": 56, "wa:codigo-ip": 56 };

const HEXTETO = /^[0-9a-f]{1,4}$/;

/** Los ocho hextetos de una IPv6 en minúsculas, o null si no lo es. */
function hextetosDeIpv6(ip: string): number[] | null {
  let s = ip.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  if (!s.includes(":")) return null;

  const v4 = /(?<=:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((o) => o > 255)) return null;
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const mitades = s.split("::");
  if (mitades.length > 2) return null;
  const partir = (t: string) => (t === "" ? [] : t.split(":"));
  const izq = partir(mitades[0]);
  const der = mitades.length === 2 ? partir(mitades[1]) : [];
  const faltan = 8 - izq.length - der.length;
  if (mitades.length === 1 ? faltan !== 0 : faltan < 1) return null;

  const grupos = [...izq, ...Array<string>(mitades.length === 2 ? faltan : 0).fill("0"), ...der];
  if (!grupos.every((g) => HEXTETO.test(g))) return null;
  return grupos.map((g) => parseInt(g, 16));
}

/**
 * La IP con la que se cuenta un cupo.
 *
 * Una IPv6 se corta al prefijo: un proveedor le da a un cliente un /64 entero,
 * y con la dirección literal cada pedido nuevo estrena cupo sin salir de su
 * máquina. La IPv4 mapeada (::ffff:a.b.c.d) es la misma IPv4 escrita de otra
 * forma. Lo que no es una IPv6 (una IPv4, un mail, un hash) vuelve como entró.
 *
 * Sólo cambia la clave del cupo: el registro de auditoría sigue guardando la
 * IP literal.
 */
export function normalizarIpParaCupo(ip: string, prefijo = PREFIJO_IPV6): string {
  const limpia = ip.trim().toLowerCase();
  const h = hextetosDeIpv6(limpia);
  if (!h) return limpia;

  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join(".");
  }

  const corte = Math.ceil(prefijo / 16);
  const conservados = h.slice(0, corte).map((x, i) => {
    const bits = Math.min(16, prefijo - i * 16);
    return x & (0xffff << (16 - bits)) & 0xffff;
  });
  return `${conservados.map((x) => x.toString(16)).join(":")}::/${prefijo}`;
}

export function claveDeCupo(ambito: AmbitoDeCupo, ...partes: string[]): string {
  const prefijo = PREFIJO_POR_AMBITO[ambito] ?? PREFIJO_IPV6;
  return [ambito, ...partes.map((p) => normalizarIpParaCupo(p, prefijo))].join(":");
}
