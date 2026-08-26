import { Workspace } from "@/components/workspace";
import { localDemoEnabled } from "@/lib/demo";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function Home() {
  if (!localDemoEnabled()) {
    if (!supabaseConfigured()) redirect("/login?error=configuration");
    const { data: { user } } = await (await createSupabaseServer()).auth.getUser();
    if (!user) redirect("/login");
  }
  return <Workspace />;
}
