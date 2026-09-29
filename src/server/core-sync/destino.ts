/**
 * A dónde se puede mandar el caso: la guarda contra SSRF del webhook al Core.
 *
 * La URL la escribe un admin, así que es entrada de usuario apuntada desde
 * nuestra red. Se resuelve UNA vez y se conecta a la IP que se validó (ver
 * `real.ts`): resolver de nuevo al conectar dejaría que un DNS que cambia de
 * respuesta entre las dos (rebinding) nos lleve a 169.254.169.254.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class DestinoRechazado extends Error {
  constructor(readonly motivo: string) {
    super(`destino rechazado: ${motivo}`);
    this.name = "DestinoRechazado";
  }
}

export interface Destino {
  host: string;
  ip: string;
  familia: 4 | 6;
}

const LARGO_MAXIMO = 2048;

const V4_VEDADAS = new BlockList();
for (const [red, prefijo] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  V4_VEDADAS.addSubnet(red, prefijo, "ipv4");
}

/** Los 16 bytes de una IPv6 ya validada por `isIP`, con `::` y cola IPv4. */
function bytesDeIPv6(ip: string): number[] {
  let texto = ip.split("%")[0];
  const cola = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(texto);
  if (cola) {
    const [a, b, c, d] = cola.slice(1).map(Number);
    texto = texto.slice(0, cola.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [izq, der] = texto.split("::");
  const grupos = (s: string) => (s ? s.split(":") : []);
  const todos =
    der === undefined
      ? grupos(izq)
      : [...grupos(izq), ...Array<string>(8 - grupos(izq).length - grupos(der).length).fill("0"), ...grupos(der)];
  return todos.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

/*
 * IPv6 va por lista blanca: sólo unicast global (2000::/3), menos Teredo,
 * documentación y 6to4, que esconden o no son destinos reales. Así quedan
 * afuera ::1, fc00::/7, fe80::/10, ff00::/8 y 64:ff9b::/96 sin enumerarlos.
 * Una IPv4 mapeada (::ffff:a.b.c.d) es una IPv4 y se juzga como tal.
 */
function esPublica(ip: string): boolean {
  const familia = isIP(ip);
  if (familia === 4) return !V4_VEDADAS.check(ip, "ipv4");
  if (familia !== 6) return false;

  const b = bytesDeIPv6(ip);
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return esPublica(b.slice(12).join("."));
  }
  if ((b[0] & 0xe0) !== 0x20) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;
  if (b[0] === 0x20 && b[1] === 0x02) return false;
  return true;
}

/** Lo que se puede decir de la URL sin resolverla. Lo usa también el PATCH de la config. */
export function revisarForma(url: string): string {
  if (url.length > LARGO_MAXIMO) throw new DestinoRechazado("largo");

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DestinoRechazado("url_invalida");
  }
  if (u.protocol !== "https:") throw new DestinoRechazado("protocolo");
  // WHATWG deja `port` vacío para el 443 de https: cualquier otro valor es otro puerto.
  if (u.port !== "") throw new DestinoRechazado("puerto");
  if (u.username || u.password) throw new DestinoRechazado("credenciales");

  // URL ya pasó 2130706433, 0177.0.0.1 y 0x7f.1 a 127.0.0.1: con esto alcanza
  // para rechazar cualquier IP escrita a mano, en la forma que sea.
  const host = u.hostname;
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw new DestinoRechazado("ip_literal");
  return host;
}

export async function validarDestino(url: string): Promise<Destino> {
  const host = revisarForma(url);
  const direcciones = await lookup(host, { all: true, verbatim: true });
  if (direcciones.length === 0) throw new DestinoRechazado("sin_direcciones");
  // TODAS: si una sola es interna, el sistema operativo puede elegir ésa.
  if (!direcciones.every((d) => esPublica(d.address))) throw new DestinoRechazado("direccion_interna");

  const [primera] = direcciones;
  return { host, ip: primera.address, familia: primera.family === 6 ? 6 : 4 };
}
