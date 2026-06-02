/**
 * /sign-in — alias for /login.
 * Redirects to /login for canonical URL.
 */

import { redirect } from "next/navigation";

export default function SignInPage() {
  redirect("/login");
}
