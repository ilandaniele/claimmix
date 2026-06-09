import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

export async function provisionGoogleUserIfAllowed(userId: string): Promise<void> {
  const serviceClient = createServiceClient();
  const { data: userProfile } = await serviceClient
    .from("users" as never)
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (userProfile) return;

  const tenantId =
    process.env.GOOGLE_DEFAULT_TENANT_ID ??
    process.env.DEFAULT_TENANT_ID ??
    process.env.GMAIL_TENANT_ID;

  if (!tenantId) {
    throw new Error("GOOGLE_DEFAULT_TENANT_ID is required for first-time Google users");
  }

  const { data: authUser } = await serviceClient.auth.admin.getUserById(userId);
  const fullName =
    (authUser.user?.user_metadata?.full_name as string | undefined) ??
    (authUser.user?.user_metadata?.name as string | undefined) ??
    authUser.user?.email ??
    "Analyst";

  const { error } = await serviceClient
    .from("users" as never)
    .insert({
      id: userId,
      tenant_id: tenantId,
      full_name: fullName,
      role: "analyst",
    } as never);

  if (error) {
    throw new Error(`google_user_provision_failed:${error.code}`);
  }
}

