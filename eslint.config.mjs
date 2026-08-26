import nextConfig from "eslint-config-next";

export default [
  ...nextConfig,
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "tests/**",
      // Las genera el SDK de flujos en cada build, ya vienen con su propio
      // `/* eslint-disable */` — que a su vez dispara "unused eslint-disable"
      // y hace fallar el lint con --max-warnings=0. No son código nuestro.
      "src/app/.well-known/workflow/**",
    ],
  },
  {
    rules: {
      // TanStack Table's useReactTable() returns non-memoizable functions — known pattern.
      "react-hooks/incompatible-library": "warn",
    },
  },
];
