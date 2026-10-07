/**
 * `remitenteVerificado`: por `email` el From se prueba contra la cabecera de
 * Gmail; por los demás canales vale lo que `autenticacionFallida`.
 */

import { describe, it, expect } from "vitest";
import { ORIGEN_WEB, autenticacionFallida, remitenteVerificado } from "@/core/email/autenticacion";

const cab = (value: string, name = "Authentication-Results") => [{ name, value }];
const FROM = "Ana Pérez <ana@example.com>";
const verificado = (value: string, from = FROM) => remitenteVerificado(cab(value), from, "email");

describe("remitenteVerificado — canal email", () => {
  it("un dmarc=pass alcanza", () => {
    expect(verificado("mx.google.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com")).toBe(true);
  });

  it("un spf=pass con el smtp.mailfrom del dominio del From alinea", () => {
    expect(verificado("mx.google.com; spf=pass (google.com: domain of ana@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=ana@example.com")).toBe(true);
  });

  it("un spf=pass con el smtp.mailfrom de un subdominio del From alinea", () => {
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=bounce@mail.example.com")).toBe(true);
  });

  it("un spf=pass con el smtp.mailfrom de otro dominio y sin dkim no alinea", () => {
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=bounce@atacante.example")).toBe(false);
  });

  it("un dkim=pass con header.d de un subdominio del From alinea", () => {
    expect(verificado("mx.google.com; dkim=pass header.i=@mail.example.com header.d=mail.example.com header.s=sel1")).toBe(true);
  });

  it("un dkim=pass con header.i=@dominio del From alinea", () => {
    expect(verificado("mx.google.com; dkim=pass header.i=@example.com header.s=sel1")).toBe(true);
  });

  it("un dkim=pass con la firma de otro dominio no alinea", () => {
    expect(verificado("mx.google.com; dkim=pass header.i=@atacante.example header.d=atacante.example")).toBe(false);
  });

  it("el spoof clásico: SPF y DKIM del atacante pasan, DMARC falla", () => {
    expect(
      verificado(
        "mx.google.com; dkim=pass header.i=@atacante.example; spf=pass smtp.mailfrom=bounce@atacante.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=example.com"
      )
    ).toBe(false);
  });

  it("un dmarc=fail anotado por Gmail corta aunque el spf o el dkim del dominio del From pasen", () => {
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=ana@example.com; dmarc=fail")).toBe(false);
    expect(verificado("mx.google.com; dkim=pass header.d=example.com; dmarc=fail header.from=example.com")).toBe(false);
  });

  it("un spf=fail o un dkim=fail del dominio del From no verifican", () => {
    expect(verificado("mx.google.com; spf=fail smtp.mailfrom=ana@example.com")).toBe(false);
    expect(verificado("mx.google.com; spf=softfail smtp.mailfrom=ana@example.com; dkim=fail header.i=@example.com")).toBe(false);
  });

  it("el sufijo sin el punto no es un subdominio", () => {
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=x@malexample.com")).toBe(false);
    expect(verificado("mx.google.com; dkim=pass header.d=example.com.atacante.example")).toBe(false);
  });

  it("el dominio padre del From no alinea: sólo el mismo o un subdominio", () => {
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=x@example.com", "ana@mail.example.com")).toBe(false);
  });

  it("el dominio sale del From con nombre y comillas, y el nombre no engaña", () => {
    const spf = "mx.google.com; spf=pass smtp.mailfrom=x@example.com";
    expect(verificado(spf, '"Ana, de ventas" <ana@example.com>')).toBe(true);
    expect(verificado(spf, '"ana@example.com" <ana@atacante.example>')).toBe(false);
    expect(verificado(spf, "ANA@EXAMPLE.COM")).toBe(true);
  });

  it("un From sin dominio no alinea con nada, tampoco con un dmarc=pass", () => {
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=x@example.com", "")).toBe(false);
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=example.com", "5491100000000")).toBe(false);
    expect(verificado("mx.google.com; dmarc=pass header.from=example.com", "")).toBe(false);
  });

  it("un dmarc=pass sólo vale si su header.from es el dominio del From", () => {
    expect(verificado("mx.google.com; dmarc=pass header.from=mail.example.com")).toBe(true);
    expect(verificado("mx.google.com; dmarc=pass header.from=atacante.example")).toBe(false);
    expect(verificado("mx.google.com; dmarc=pass header.from=malexample.com")).toBe(false);
    expect(verificado("mx.google.com; dmarc=pass")).toBe(false);
  });

  it("un From con un comentario que imita otra dirección se prueba por la dirección real, no por la del comentario", () => {
    // Gmail evalúa a atacante.example; el dominio del comentario no cuenta ni a favor ni en contra.
    const from = "atacante@atacante.example (<victima@example.com>)";
    expect(verificado("mx.google.com; dmarc=pass header.from=atacante.example", from)).toBe(true);
    expect(verificado("mx.google.com; dmarc=pass header.from=example.com", from)).toBe(false);
  });

  it("el smtp.mailfrom puede venir sin la parte local", () => {
    expect(verificado("mx.google.com; spf=pass smtp.mailfrom=example.com")).toBe(true);
  });

  it("sin cabecera de Authentication-Results no verifica", () => {
    expect(remitenteVerificado([], FROM, "email")).toBe(false);
    expect(remitenteVerificado(undefined, FROM, "email")).toBe(false);
    expect(remitenteVerificado(null, FROM, "email")).toBe(false);
    expect(remitenteVerificado({}, FROM, "email")).toBe(false);
    expect(remitenteVerificado([{ name: "Received-SPF", value: "pass" }], FROM, "email")).toBe(false);
  });

  it("una cabecera que no es de mx.google.com no verifica, diga lo que diga", () => {
    expect(verificado("evil.example; dmarc=pass header.from=example.com")).toBe(false);
    expect(verificado("not-mx.google.com; dmarc=pass")).toBe(false);
  });

  it("ARC-Authentication-Results sola no cuenta", () => {
    expect(remitenteVerificado(cab("mx.google.com; dmarc=pass", "ARC-Authentication-Results"), FROM, "email")).toBe(false);
  });

  it("un dmarc=pass adentro de los paréntesis del arc no es el veredicto de Gmail", () => {
    expect(
      verificado("mx.google.com; arc=pass (i=1 spf=pass spfdomain=example.com dkim=pass dkdomain=example.com dmarc=pass fromdomain=example.com); spf=softfail smtp.mailfrom=x@relay.example")
    ).toBe(false);
  });

  it("una Authentication-Results escrita por el remitente arriba de la de Gmail deja a la de Gmail sin efecto", () => {
    const headers = [
      { name: "Authentication-Results", value: "evil.example; dmarc=fail" },
      { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example.com" },
    ];
    expect(remitenteVerificado(headers, FROM, "email")).toBe(false);
  });

  it("una escrita por el remitente debajo de la de Gmail no suma", () => {
    const headers = [
      { name: "Authentication-Results", value: "mx.google.com; spf=none; dkim=none; dmarc=none" },
      { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example.com" },
    ];
    expect(remitenteVerificado(headers, FROM, "email")).toBe(false);
  });

  it("no distingue mayúsculas en el nombre de la cabecera ni en los dominios", () => {
    expect(remitenteVerificado(cab("MX.GOOGLE.COM; SPF=PASS SMTP.MAILFROM=Ana@Example.COM", "AUTHENTICATION-RESULTS"), FROM, "email")).toBe(true);
  });

  it("acepta la cabecera plegada en varias líneas", () => {
    expect(verificado("mx.google.com;\r\n       dkim=pass header.i=@example.com header.s=sel1;\r\n       spf=none")).toBe(true);
  });

  it("un ; adentro de un smtp.mailfrom entre comillas no abre un veredicto: no cuela un dmarc=pass", () => {
    // La parte local la escribe quien manda el mensaje; Gmail la deja entre comillas.
    expect(
      verificado('mx.google.com; spf=pass smtp.mailfrom="a;dmarc=pass"@atacante.example; dmarc=fail header.from=example.com')
    ).toBe(false);
    expect(verificado('mx.google.com; spf=softfail smtp.mailfrom="a;dmarc=pass"@atacante.example')).toBe(false);
  });

  it("una comilla escapada no cierra el valor: lo que sigue sigue siendo del atacante", () => {
    expect(verificado('mx.google.com; spf=pass smtp.mailfrom="a\\";dmarc=pass"@atacante.example')).toBe(false);
  });

  it("una comilla o un paréntesis sin cerrar dejan la cabecera sin leer", () => {
    expect(verificado('mx.google.com; spf=pass smtp.mailfrom="x@example.com; dmarc=pass')).toBe(false);
    expect(verificado("mx.google.com; spf=pass (comentario sin cerrar smtp.mailfrom=x@example.com; dmarc=pass")).toBe(false);
  });

  it("un smtp.mailfrom entero entre comillas (Gmail las pone si trae un =) alinea con el From", () => {
    expect(verificado('mx.google.com; spf=pass smtp.mailfrom="bounce+x=y@mg.example.com"')).toBe(true);
    expect(verificado('mx.google.com; spf=pass smtp.mailfrom="bounce+x=y@mg.atacante.example"')).toBe(false);
  });

  it("los comentarios anidados no cortan el veredicto de al lado", () => {
    expect(verificado("mx.google.com; spf=pass (google.com: (ip 1.2.3.4) permitted) smtp.mailfrom=ana@example.com")).toBe(true);
  });
});

describe("autenticacionFallida — el ; entre comillas", () => {
  it("un dmarc=pass escrito adentro de un valor entre comillas no tapa un spf=softfail", () => {
    expect(
      autenticacionFallida(cab('mx.google.com; spf=softfail smtp.mailfrom="a;dmarc=pass"@atacante.example'))
    ).toBe(true);
  });

  it("un dmarc=pass real de Gmail sigue tapando un spf=softfail", () => {
    expect(
      autenticacionFallida(cab("mx.google.com; spf=softfail smtp.mailfrom=x@relay.example; dmarc=pass header.from=example.com"))
    ).toBe(false);
  });
});

describe("remitenteVerificado — los demás canales", () => {
  it("email_sim sin cabeceras vale como siempre", () => {
    expect(remitenteVerificado([], "ana@example.com", "email_sim")).toBe(true);
    expect(remitenteVerificado(undefined, "ana@example.com", "email_sim")).toBe(true);
  });

  it("WhatsApp guarda {} en vez de una lista y no falló", () => {
    expect(remitenteVerificado({}, "5491100000000", "whatsapp")).toBe(true);
  });

  it("una falla explícita sigue contando, en cualquier canal", () => {
    expect(remitenteVerificado(cab("mx.google.com; spf=fail smtp.mailfrom=x@y"), FROM, "email_sim")).toBe(false);
    expect(remitenteVerificado(cab("mx.google.com; dmarc=fail"), FROM, "whatsapp")).toBe(false);
  });

  it("neutral y none no fallan fuera de email", () => {
    expect(remitenteVerificado(cab("mx.google.com; spf=neutral"), FROM, "email_sim")).toBe(true);
  });

  it("el formulario web no está verificado", () => {
    expect(remitenteVerificado([ORIGEN_WEB], FROM, "web")).toBe(false);
  });
});
