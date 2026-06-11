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
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { getServerLocale } from "@/lib/i18n/locale";
import { ThemeProvider } from "@/lib/theme/ThemeContext";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Direct lookup by PK — no unstable_cache because cookies() cannot be called
  // inside a cached function in Next.js 15+ (causes 500 on cache-miss for new sessions).
  let userRow: { full_name: string; role: string; locale?: string | null } | null = null;
  if (user?.id) {
    // select("*") instead of naming columns: keeps working whether or not the
    // optional `locale` column (migration 0016) exists yet.
    const { data } = await (supabase as any)
      .from("users")
      .select("*")
      .eq("id", user.id)
      .single();
    userRow = data ?? null;
  }

  const fullName: string = userRow?.full_name ?? user?.email ?? "Analista";
  const role: string = userRow?.role ?? "analyst";
  // Account preference wins over the device cookie (so the saved language
  // follows the user to any device); cookie/default covers the rest.
  const cookieLocale = await getServerLocale();
  const accountLocale = userRow?.locale;
  const locale =
    accountLocale === "es-AR" || accountLocale === "en-US"
      ? accountLocale
      : cookieLocale;

  return (
    <LocaleProvider locale={locale}>
      <ThemeProvider>
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
      </ThemeProvider>
    </LocaleProvider>
  );
}
