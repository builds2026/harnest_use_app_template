import { NextResponse } from "next/server";
import { localDemoEnabled } from "@/lib/demo";
import { sha256Hex } from "@/lib/file-integrity";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/iu;

export async function GET(request: Request) {
  if (!supabaseConfigured()) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !UUID.test(id)) return NextResponse.json({ error: "Invalid file reference." }, { status: 400 });
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const admin = createSupabaseAdmin();
  const file = await admin.from("files").select("storage_bucket,storage_path").eq("id", id).eq("user_id", user.id).neq("status", "deleted").single();
  if (file.error) return NextResponse.json({ error: "File not found." }, { status: 404 });
  const signed = await admin.storage.from(file.data.storage_bucket).createSignedUrl(file.data.storage_path, 60);
  if (signed.error) return NextResponse.json({ error: "Could not open file." }, { status: 502 });
  return NextResponse.redirect(signed.data.signedUrl, 303);
}

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  const conversationId = form.get("conversationId");
  const runId = form.get("runId");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_FILE_BYTES || (conversationId !== null && (typeof conversationId !== "string" || !UUID.test(conversationId)))) {
    return NextResponse.json({ error: "A file up to 20 MiB is required." }, { status: 400 });
  }
  if (localDemoEnabled()) {
    const sha256 = await sha256Hex(file);
    return NextResponse.json({ id: crypto.randomUUID(), fileRef: "demo-file-ref", name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, sha256, status: "local-only" });
  }
  if (!supabaseConfigured()) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });

  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  let ownedConversationId = conversationId as string | null;
  if (!ownedConversationId) {
    const created = await supabase.from("conversations").insert({ user_id: user.id, title: file.name.slice(0, 200) }).select("id").single();
    if (created.error) return NextResponse.json({ error: "Could not create a conversation for this file." }, { status: 400 });
    ownedConversationId = created.data.id;
  }
  const sha256 = await sha256Hex(file);
  const id = crypto.randomUUID();
  const path = `${user.id}/${ownedConversationId}/${id}/${file.name.replace(/[^A-Za-z0-9._-]/gu, "_")}`;
  const upload = await supabase.storage.from("user-files").upload(path, file, { contentType: file.type, upsert: false });
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 400 });
  const admin = createSupabaseAdmin();
  const result = await admin.from("files").insert({
    id, user_id: user.id, conversation_id: ownedConversationId, storage_bucket: "user-files", storage_path: path,
    name: file.name, mime_type: file.type || "application/octet-stream", size_bytes: file.size, sha256, status: "ready",
  }).select("id,name,mime_type,size_bytes,sha256,status").single();
  if (result.error) {
    await supabase.storage.from("user-files").remove([path]);
    return NextResponse.json({ error: result.error.message }, { status: 400 });
  }
  let fileRef: string | undefined;
  if (typeof runId === "string" && /^[0-9a-f-]{36}$/iu.test(runId)) {
    const run = await admin.from("runs").select("input").eq("id", runId).eq("user_id", user.id).eq("conversation_id", ownedConversationId).single();
    const input = run.data?.input && typeof run.data.input === "object" ? run.data.input as Record<string, unknown> : {};
    if (!run.error && typeof input.contextRef === "string") {
      const context = await admin.from("context_refs").select("file_ids").eq("id", input.contextRef).eq("user_id", user.id).single();
      if (!context.error) {
        const ids = [...new Set([...(context.data.file_ids as string[]), result.data.id])];
        const updated = await admin.from("context_refs").update({ file_ids: ids }).eq("id", input.contextRef).eq("user_id", user.id);
        if (!updated.error) fileRef = `f.${input.contextRef}.${ids.indexOf(result.data.id)}`;
      }
    }
  }
  return NextResponse.json({ id: result.data.id, conversationId: ownedConversationId, ...(fileRef ? { fileRef } : {}), name: result.data.name, mimeType: result.data.mime_type, size: result.data.size_bytes, sha256: result.data.sha256, status: result.data.status });
}
