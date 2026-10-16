"use client";

/**
 * El desafío de Turnstile, dibujado recién cuando React ya hidrató.
 *
 * Con el render implícito, `api.js` llenaba la caja apenas bajaba. Si llegaba
 * antes de que React hidratara, React encontraba un iframe que el servidor no
 * había mandado (error #418), volvía a pintar el formulario y la caja quedaba
 * vacía: sin desafío, nadie podía crear cuenta con el correo. Pasaba a veces,
 * según quién llegara primero. Acá el script se pide en el efecto, con
 * `render=explicit`, y la caja se llena a mano.
 */

import { useEffect, useRef } from "react";

const API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface Turnstile {
  render(caja: HTMLElement, opciones: { sitekey: string }): string | undefined;
  remove(id: string): void;
}

export function DesafioTurnstile({ clave, nonce }: { clave: string; nonce: string | undefined }) {
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ventana = window as Window & { turnstile?: Turnstile };
    let id: string | undefined;
    const dibujar = () => {
      if (caja.current && ventana.turnstile) id = ventana.turnstile.render(caja.current, { sitekey: clave });
    };

    let script = document.querySelector<HTMLScriptElement>(`script[src="${API}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = API;
      script.async = true;
      if (nonce) script.nonce = nonce;
      document.head.append(script);
    }
    if (ventana.turnstile) dibujar();
    else script.addEventListener("load", dibujar);

    return () => {
      script.removeEventListener("load", dibujar);
      if (id) ventana.turnstile?.remove(id);
    };
  }, [clave, nonce]);

  return <div ref={caja} className="cf-turnstile" data-sitekey={clave} />;
}
