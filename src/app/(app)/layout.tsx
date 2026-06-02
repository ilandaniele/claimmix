/**
 * App shell layout — wraps all authenticated pages under (app)/ route group.
 *
 * Structure:
 *   - Left sidebar with navigation
 *   - Top bar with user info and command palette trigger
 *   - Main content area
 *
 * This layout is only rendered for authenticated users (enforced by proxy.ts).
 * It fetches the current user's profile from Supabase to display name/initials.
 */

import { createServerClient } from "@/lib/supabase/server";
import { Sidebar } from "./_components/Sidebar";
import { TopBar } from "./_components/TopBar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fetch user profile — proxy.ts guarantees a valid session exists at this point.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Fetch analyst row to get full_name and role.
   
  const { data: userRow } = await (supabase as any)
    .from("users")
    .select("full_name, role")
    .eq("id", user?.id ?? "")
    .single();

  const fullName: string = userRow?.full_name ?? user?.email ?? "Analista";
  const role: string = userRow?.role ?? "analyst";

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Left sidebar */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top navigation bar */}
        <TopBar fullName={fullName} role={role} />

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
