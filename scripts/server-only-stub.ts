/**
 * A no-op stand-in for Next's `server-only` marker.
 *
 * That specifier is resolved by the Next bundler, not by Node: it exists to
 * make the build fail if a server module is ever pulled into a client bundle.
 * Plain Node has never heard of it, so every file the rehearsal loads — which
 * is every server file — fails to import.
 *
 * Mapped in tsconfig.rehearsal.json only. The real build still resolves the
 * real marker, so the guard it provides is untouched.
 */
export {};
