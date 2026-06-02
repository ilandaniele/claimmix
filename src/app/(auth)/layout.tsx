/**
 * Auth route group layout.
 * Wraps the sign-in page with a minimal centered layout.
 * No nav, no sidebar — unauthenticated shell.
 */

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
