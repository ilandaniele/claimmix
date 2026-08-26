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
    ];
  },
};

// `withWorkflow` habilita las directivas "use workflow" y "use step". Sin
// esto, una función marcada con ellas corre como una función normal: anda, y no
// es durable — que es la peor de las dos fallas posibles, porque no se nota.
export default withWorkflow(nextConfig);
