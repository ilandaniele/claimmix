/**
 * size-limit configuration for ClaimMix.
 *
 * Spec budget: main chunk < 200 KB gzipped.
 * W7 CI gate: warn if > 300 KB (soft limit; 200 KB is the hard spec target).
 *
 * Run: pnpm exec size-limit
 * Install: pnpm add -D size-limit @size-limit/preset-next-app (when needed)
 */

module.exports = [
  {
    name: "First Load JS (shared)",
    path: ".next/static/chunks/framework-*.js",
    limit: "300 kB",
    gzip: true,
  },
  {
    name: "Dashboard page JS",
    path: ".next/static/chunks/app/(app)/bandeja/page-*.js",
    limit: "200 kB",
    gzip: true,
  },
];
