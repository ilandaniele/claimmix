/**
 * Home page — redirects to /bandeja.
 * The redirect is also handled by proxy.ts for authenticated users,
 * but this server-side redirect ensures correct behavior even if middleware
 * doesn't catch the root path (e.g., direct server render).
 */

import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/bandeja");
}
