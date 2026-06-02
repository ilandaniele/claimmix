import nextConfig from "eslint-config-next";

export default [
  ...nextConfig,
  {
    ignores: [".next/**", "out/**", "build/**", "node_modules/**", "tests/**"],
  },
  {
    rules: {
      // TanStack Table's useReactTable() returns non-memoizable functions — known pattern.
      "react-hooks/incompatible-library": "warn",
    },
  },
];
