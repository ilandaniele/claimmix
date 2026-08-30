import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Optional peer dependencies (upgrade path — not installed by default).
  // Without this, Next.js/Turbopack throws "Module not found" even for dynamic imports.
  serverExternalPackages: ["@upstash/ratelimit", "@upstash/redis"],
  // Security headers (non-CSP headers that don't require per-request nonce).
  // CSP with per-request nonce is injected by proxy.ts at the middleware layer.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // X-DNS-Prefetch-Control
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
        ],
      },
      {
        /*
         * Una CSP propia para la API, más cerrada que la de las páginas.
         *
         * El proxy que arma la CSP con nonce no corre para `/api` —su matcher
         * excluye la API a propósito, porque cada handler se defiende solo— así
         * que estas respuestas no llevaban ninguna.
         *
         * En una respuesta JSON no hay nada que ejecutar, así que esto no tapa
         * un agujero conocido. Está por dos casos que sí pasan: un handler que
         * por error devuelve HTML (una página de error de un proveedor, un
         * stack de un framework), y un navegador al que alguien convence de
         * abrir una URL de la API directamente. En los dos, `default-src 'none'`
         * significa que no se carga NADA: ni script, ni imagen, ni fuente.
         *
         * Es más restrictiva que la de las páginas justamente porque acá no hay
         * nada legítimo que cargar. Una CSP con nonce sería copiar el problema
         * de las páginas a un lugar que no lo tiene.
         *
         * SIN `sandbox`, y no por descuido: `sandbox` a secas también bloquea
         * las descargas, y `/api/cases/export.csv` es exactamente eso — una
         * navegación del navegador que devuelve `Content-Disposition:
         * attachment`. La directiva que más aprieta habría roto la exportación
         * que usan los analistas todos los días.
         */
        source: "/api/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'none'",
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "form-action 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

// `withWorkflow` habilita las directivas "use workflow" y "use step". Sin
// esto, una función marcada con ellas corre como una función normal: anda, y no
// es durable — que es la peor de las dos fallas posibles, porque no se nota.
export default withWorkflow(nextConfig);
