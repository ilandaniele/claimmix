/**
 * Dashboard placeholder — redirects to /bandeja.
 * W5 implements the full /bandeja page.
 */

import { redirect } from "next/navigation";

export default function DashboardPage() {
  redirect("/bandeja");
}
