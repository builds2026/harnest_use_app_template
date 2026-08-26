import { createHash } from "node:crypto";
import { internalRequestAuthorized } from "@/lib/internal-auth";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function GET(request: Request, context: { params: Promise<{ ref: string }> }) {
  if (!internalRequestAuthorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const { ref } = await context.params;
  const selected = /^f\.([0-9a-f-]{36})\.(\d{1,3})$/iu.exec(ref);
  const generated = /^a\.([0-9a-f-]{36})\.([a-f0-9]{36})$/iu.exec(ref);
  const contextRef = selected?.[1] ?? generated?.[1];
  if (!contextRef) return Response.json({ error: "Invalid file reference." }, { status: 400 });
  const supabase = createSupabaseAdmin();
  const reference = await supabase.from("context_refs").select("user_id,file_ids,expires_at").eq("id", contextRef).single();
  if (reference.error || Date.parse(reference.data.expires_at) <= Date.now()) return Response.json({ error: "File reference is missing or expired." }, { status: 404 });

  let file: { storage_bucket: string; storage_path: string; name: string; mime_type: string; size_bytes: number; sha256: string; status: string } | undefined;
  if (selected) {
    const id = reference.data.file_ids[Number(selected[2])];
    if (id) {
      const result = await supabase.from("files").select("storage_bucket,storage_path,name,mime_type,size_bytes,sha256,status").eq("id", id).eq("user_id", reference.data.user_id).single();
      if (!result.error) file = result.data;
    }
  } else if (generated) {
    const upload = await supabase.from("provider_file_uploads").select("artifact_id").eq("provider_ref", generated[2]).eq("context_ref", contextRef).eq("user_id", reference.data.user_id).eq("status", "committed").single();
    if (!upload.error && upload.data.artifact_id) {
      const result = await supabase.from("artifacts").select("storage_bucket,storage_path,name,mime_type,size_bytes,sha256,status").eq("id", upload.data.artifact_id).eq("user_id", reference.data.user_id).single();
      if (!result.error) file = result.data;
    }
  }
  if (!file || file.status === "deleted" || file.size_bytes > MAX_FILE_BYTES || !file.sha256) return Response.json({ error: "File is not available." }, { status: 404 });
  const downloaded = await supabase.storage.from(file.storage_bucket).download(file.storage_path);
  if (downloaded.error) return Response.json({ error: "File transfer failed." }, { status: 502 });
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== file.size_bytes || digest !== file.sha256) return Response.json({ error: "File integrity verification failed." }, { status: 409 });

  let start = 0; let end = bytes.byteLength - 1; let status = 200;
  const range = request.headers.get("range");
  if (range) {
    const parsed = /^bytes=(\d+)-(\d*)$/u.exec(range);
    if (!parsed) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.byteLength}` } });
    start = Number(parsed[1]); end = parsed[2] ? Number(parsed[2]) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= bytes.byteLength) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.byteLength}` } });
    status = 206;
  }
  const body = new Blob([bytes.slice(start, end + 1)]);
  return new Response(body.stream(), { status, headers: {
    "accept-ranges": "bytes", "cache-control": "private, no-store", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "content-length": String(body.size), "content-type": file.mime_type, "x-content-sha256": digest, "x-content-type-options": "nosniff",
    ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${bytes.byteLength}` } : {}),
  } });
}
