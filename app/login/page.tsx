import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

export default async function LoginPage() {
  const configured = supabaseConfigured();
  if (configured) {
    const { data: { user } } = await (await createSupabaseServer()).auth.getUser();
    if (user) redirect("/");
  }
  return <AuthForm configured={configured} />;
}
