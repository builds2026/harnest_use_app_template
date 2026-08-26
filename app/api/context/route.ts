import { createHash } from "node:crypto";
import { contextInput, pkmChunks } from "@/lib/context-input";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

async function currentUser() {
  if (!supabaseConfigured()) return undefined;
  const { data: { user } } = await (await createSupabaseServer()).auth.getUser();
  return user;
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const input = contextInput(await request.json().catch(() => undefined));
  if ("error" in input) return Response.json(input, { status: 400 });
  const admin = createSupabaseAdmin();
  if (input.type === "memory") {
    const saved = await admin.from("memories").upsert({ user_id: user.id, conversation_id: null, key: input.key, value: input.value, provenance: { source: "user" }, scope: "user" }, { onConflict: "user_id,conversation_id,key" }).select("id,key,value,updated_at").single();
    if (saved.error) return Response.json({ error: "Could not save memory." }, { status: 502 });
    return Response.json({ memory: saved.data });
  }
  const source = await admin.from("pkm_sources").insert({ user_id: user.id, title: input.title, kind: "text", status: "syncing" }).select("id").single();
  if (source.error) return Response.json({ error: "Could not create PKM source." }, { status: 502 });
  const rows = pkmChunks(input.content).map((content, index) => ({
    user_id: user.id, source_id: source.data.id, external_ref: String(index), content,
    content_hash: createHash("sha256").update(content).digest("hex"), metadata: { index },
  }));
  const inserted = await admin.from("pkm_chunks").insert(rows);
  if (inserted.error) {
    await admin.from("pkm_sources").delete().eq("id", source.data.id).eq("user_id", user.id);
    return Response.json({ error: "Could not index PKM text." }, { status: 502 });
  }
  await admin.from("pkm_sources").update({ status: "synced", last_synced_at: new Date().toISOString() }).eq("id", source.data.id).eq("user_id", user.id);
  return Response.json({ source: { id: source.data.id, title: input.title, kind: "text", status: "synced" }, chunks: rows.length });
}

export async function DELETE(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const body = await request.json().catch(() => undefined) as { type?: unknown; id?: unknown } | undefined;
  if (!body || (body.type !== "memory" && body.type !== "pkm") || typeof body.id !== "string" || !/^[0-9a-f-]{36}$/iu.test(body.id)) return Response.json({ error: "Invalid context reference." }, { status: 400 });
  const table = body.type === "memory" ? "memories" : "pkm_sources";
  const deleted = await createSupabaseAdmin().from(table).delete().eq("id", body.id).eq("user_id", user.id).select("id").maybeSingle();
  if (deleted.error) return Response.json({ error: "Could not remove context." }, { status: 502 });
  return Response.json({ deleted: Boolean(deleted.data) });
}
