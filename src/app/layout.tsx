/**
 * Root layout — ClaimMix.
 *
 * Reads the CSP nonce from the x-csp-nonce response header set by proxy.ts.
 * Any inline script or style that uses a nonce must receive this value via props.
 *
 * Language: es-AR (per IC7 — single locale, no i18n framework).
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import { SCRIPT_TEMA_INICIAL } from "@/lib/theme/script-inicial";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClaimMix — FNOL",
  description: "Gestión inteligente de siniestros de seguros",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the nonce injected by proxy.ts so Next.js inline scripts can use it.
  // headers() is async in Next.js 15+/16 — must await.
  const headersList = await headers();
  const nonce = headersList.get("x-csp-nonce") ?? undefined;

  return (
    <html lang="es-AR" className="h-full antialiased">
      <head>
        {/*
          Nonce is passed to Next.js via the `nonce` prop on Script tags.
          Example:
            import Script from 'next/script';
            <Script nonce={nonce} id="my-script">...</Script>
        */}
        {/*
          El tema, decidido ANTES del primer pintado.

          El tema lo elegía `ThemeProvider` en un `useEffect`, o sea después de
          que la página ya se dibujó. Medido: con el sistema en oscuro, el
          servidor mandaba `class="h-full antialiased"` y el fondo salía
          rgb(248,250,252) —blanco— hasta que el efecto lo pasaba a
          rgb(11,17,32). Un destello blanco en cada carga completa, para todo el
          que tenga el sistema en oscuro.

          No hay forma de arreglarlo desde React: el servidor no puede saber qué
          tema quiere este navegador, y cualquier cosa que corra después de
          hidratar corre después de pintar. Tiene que ser un script bloqueante
          en el <head>, que es lo único que pasa entre el HTML y la pantalla.

          Lleva el nonce porque el CSP es `script-src 'self' 'nonce-…'
          'strict-dynamic'`, sin `unsafe-inline`: sin el nonce no corre y el
          destello vuelve sin que nada falle a la vista.

          Toca el DOM y no React, así que no participa de la hidratación. La
          clave y la lógica son las mismas que las de ThemeContext; si una
          cambia, la otra tiene que cambiar — el test las compara.
        */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: SCRIPT_TEMA_INICIAL,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
