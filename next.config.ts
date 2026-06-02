import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
  images: {
    remotePatterns: [
      // Add Supabase storage domain when file uploads are added.
      // { protocol: 'https', hostname: '*.supabase.co' },
    ],
  },
};

export default nextConfig;
