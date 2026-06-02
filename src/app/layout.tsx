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
          The layout itself doesn't add inline scripts, but child pages may.
          Example:
            import Script from 'next/script';
            <Script nonce={nonce} id="my-script">...</Script>
        */}
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
