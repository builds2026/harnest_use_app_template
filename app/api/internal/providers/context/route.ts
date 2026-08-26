import { createHash, randomUUID } from "node:crypto";
import { internalRequestAuthorized } from "@/lib/internal-auth";
import { connectionCredential } from "@/lib/oauth";
import { providerArtifactPath, sameFile } from "@/lib/provider-file-commit";
import { decodeProviderCursor, nextProviderCursor, providerPageLimit } from "@/lib/provider-cursor";
import { connectionTargetAllowed, providerResult, PROVIDER_VALUE_BYTES, serializedBytes } from "@/lib/provider-security";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const ref = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const response = providerResult;
const failure = (message: string, status = 400) => Response.json({ error: message }, { status });
const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
const safeConfiguration = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(safeConfiguration);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).flatMap(([key, entry]) => /secret|token|password|authorization|api.?key|credential/iu.test(key) ? [] : [[key, safeConfiguration(entry)]]));
};

async function resolveContext(contextRef: string) {
  return createSupabaseAdmin().from("context_refs").select("user_id,conversation_id,file_ids,expires_at").eq("id", contextRef).single();
}

export async function POST(request: Request) {
  if (!internalRequestAuthorized(request)) return failure("Unauthorized.", 401);
  const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const providerRequest = record(body?.request);
  const contextRef = body?.contextRef;
  if (!body || typeof body.operation !== "string" || !providerRequest || !ref(contextRef)) return failure("Invalid provider request.");
  const resolved = await resolveContext(contextRef);
  if (resolved.error || Date.parse(resolved.data.expires_at) <= Date.now()) return failure("Context reference is missing or expired.", 404);
  const supabase = createSupabaseAdmin();
  const { user_id: userId, conversation_id: conversationId, file_ids: fileIds } = resolved.data;
  const limit = providerPageLimit(providerRequest.limit);
  const offset = decodeProviderCursor(providerRequest.cursor);
  if (offset === undefined) return failure("Invalid cursor.");

  if (body.operation === "conversation.read") {
    const [conversation, messages] = await Promise.all([
      supabase.from("conversations").select("updated_at").eq("id", conversationId).eq("user_id", userId).single(),
      supabase.from("messages").select("role,content,created_at").eq("conversation_id", conversationId).eq("user_id", userId).order("created_at").range(offset, offset + limit),
    ]);
    if (conversation.error || messages.error) return failure("Conversation provider failed.", 502);
    const rows = messages.data ?? [];
    return response({ messages: rows.slice(0, limit).map(({ role, content, created_at }) => ({ role, content, createdAt: created_at })), revision: conversation.data.updated_at, cursor: nextProviderCursor(offset, rows.length, limit) });
  }

  if (body.operation === "memory.search") {
    const namespace = providerRequest.namespace;
    if (namespace !== "user" && namespace !== "conversation" && namespace !== "pkm") return failure("Invalid memory namespace.");
    if (namespace === "pkm") {
      let query = supabase.from("pkm_chunks").select("content_hash,content,metadata,updated_at,pkm_sources!inner(title)").eq("user_id", userId).order("updated_at", { ascending: false });
      if (typeof providerRequest.query === "string" && providerRequest.query.trim()) query = query.textSearch("content", providerRequest.query, { type: "websearch" });
      const result = await query.range(offset, offset + limit);
      if (result.error) return failure("PKM provider failed.", 502);
      const rows = result.data ?? [];
      return response({ records: rows.slice(0, limit).map((row) => ({ id: `pkm.${row.content_hash}`, namespace, value: row.content, provenance: { source: "pkm", sourceId: row.content_hash, title: (row.pkm_sources as unknown as { title?: string })?.title, revision: row.updated_at }, revision: row.updated_at })), revision: rows[0]?.updated_at ?? "empty", cursor: nextProviderCursor(offset, rows.length, limit) });
    }
    let query = supabase.from("memories").select("key,value,provenance,updated_at").eq("user_id", userId).order("updated_at", { ascending: false });
    query = namespace === "user" ? query.is("conversation_id", null) : query.eq("conversation_id", conversationId);
    if (typeof providerRequest.query === "string" && providerRequest.query.trim()) query = query.ilike("key", `%${providerRequest.query.replace(/[%_,]/gu, "")}%`);
    const result = await query.range(offset, offset + limit);
    if (result.error) return failure("Memory provider failed.", 502);
    const rows = result.data ?? [];
    return response({ records: rows.slice(0, limit).map(({ key, value, provenance, updated_at }) => ({ id: key, namespace, value, provenance, revision: updated_at })), revision: rows[0]?.updated_at ?? "empty", cursor: nextProviderCursor(offset, rows.length, limit) });
  }

  if (body.operation === "memory.upsert") {
    const namespace = providerRequest.namespace;
    if (namespace !== "user" && namespace !== "conversation") return failure("Only user and conversation memory can be written.");
    const id = typeof providerRequest.id === "string" ? providerRequest.id : `memory_${randomUUID().replaceAll("-", "")}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || !record(providerRequest.provenance) || serializedBytes(providerRequest.value) > PROVIDER_VALUE_BYTES || serializedBytes(providerRequest.provenance) > PROVIDER_VALUE_BYTES) return failure("Invalid or oversized memory record.", 413);
    const conversation = namespace === "user" ? null : conversationId;
    if (providerRequest.revision !== undefined) {
      const existing = await supabase.from("memories").select("updated_at").eq("user_id", userId).eq("key", id).is("conversation_id", conversation).maybeSingle();
      if (existing.error || existing.data?.updated_at !== providerRequest.revision) return failure("Memory revision conflict.", 409);
    }
    const saved = await supabase.from("memories").upsert({ user_id: userId, conversation_id: conversation, key: id, value: providerRequest.value, provenance: providerRequest.provenance, scope: namespace }, { onConflict: "user_id,conversation_id,key" }).select("key,value,provenance,updated_at").single();
    if (saved.error) return failure("Memory write failed.", 502);
    return response({ id: saved.data.key, namespace, value: saved.data.value, provenance: saved.data.provenance, revision: saved.data.updated_at });
  }

  if (body.operation === "memory.delete") {
    const namespace = providerRequest.namespace;
    if ((namespace !== "user" && namespace !== "conversation") || typeof providerRequest.id !== "string") return failure("Invalid memory delete.");
    let query = supabase.from("memories").select("updated_at").eq("user_id", userId).eq("key", providerRequest.id);
    query = namespace === "user" ? query.is("conversation_id", null) : query.eq("conversation_id", conversationId);
    const existing = await query.maybeSingle();
    if (existing.error || !existing.data) return failure("Memory record was not found.", 404);
    if (providerRequest.revision !== undefined && existing.data.updated_at !== providerRequest.revision) return failure("Memory revision conflict.", 409);
    let deletion = supabase.from("memories").delete().eq("user_id", userId).eq("key", providerRequest.id);
    deletion = namespace === "user" ? deletion.is("conversation_id", null) : deletion.eq("conversation_id", conversationId);
    const deleted = await deletion;
    if (deleted.error) return failure("Memory delete failed.", 502);
    return response({ revision: new Date().toISOString() });
  }

  if (body.operation === "cache.get") {
    if ((providerRequest.namespace !== "context" && providerRequest.namespace !== "provider-prompt") || typeof providerRequest.key !== "string") return failure("Invalid cache key.");
    const found = await supabase.from("cache_entries").select("value,etag,expires_at,updated_at").eq("user_id", userId).eq("namespace", providerRequest.namespace).eq("key_hash", keyHash(providerRequest.key)).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (found.error) return failure("Cache read failed.", 502);
    return response(found.data ? { namespace: providerRequest.namespace, key: providerRequest.key, value: found.data.value, etag: found.data.etag, revision: found.data.updated_at, expiresAt: found.data.expires_at } : null);
  }

  if (body.operation === "cache.put") {
    if ((providerRequest.namespace !== "context" && providerRequest.namespace !== "provider-prompt") || typeof providerRequest.key !== "string" || typeof providerRequest.ttlMs !== "number" || !Number.isFinite(providerRequest.ttlMs) || providerRequest.ttlMs < 1_000 || providerRequest.ttlMs > 86_400_000) return failure("Invalid cache write.");
    const hash = keyHash(providerRequest.key);
    const existing = await supabase.from("cache_entries").select("etag").eq("user_id", userId).eq("namespace", providerRequest.namespace).eq("key_hash", hash).maybeSingle();
    if (existing.error) return failure("Cache write failed.", 502);
    if (typeof providerRequest.etag === "string" && existing.data?.etag !== providerRequest.etag) return failure("Cache ETag conflict.", 409);
    const etag = randomUUID(); const expiresAt = new Date(Date.now() + providerRequest.ttlMs).toISOString();
    const encoded = JSON.stringify(providerRequest.value); if (encoded.length > 1_048_576) return failure("Cache value is too large.", 413);
    const saved = await supabase.from("cache_entries").upsert({ user_id: userId, namespace: providerRequest.namespace, key_hash: hash, value: providerRequest.value, size_bytes: new TextEncoder().encode(encoded).byteLength, etag, expires_at: expiresAt }, { onConflict: "user_id,namespace,key_hash" }).select("value,etag,expires_at,updated_at").single();
    if (saved.error) return failure("Cache write failed.", 502);
    return response({ namespace: providerRequest.namespace, key: providerRequest.key, value: saved.data.value, etag: saved.data.etag, revision: saved.data.updated_at, expiresAt: saved.data.expires_at });
  }

  if (body.operation === "cache.delete") {
    if ((providerRequest.namespace !== "context" && providerRequest.namespace !== "provider-prompt") || typeof providerRequest.key !== "string") return failure("Invalid cache delete.");
    let query = supabase.from("cache_entries").delete().eq("user_id", userId).eq("namespace", providerRequest.namespace).eq("key_hash", keyHash(providerRequest.key));
    if (typeof providerRequest.etag === "string") query = query.eq("etag", providerRequest.etag);
    const deleted = await query.select("key_hash").maybeSingle();
    if (deleted.error) return failure("Cache delete failed.", 502);
    return response(Boolean(deleted.data));
  }

  const permissionScope = record(providerRequest.scope) ?? providerRequest;
  const validScope = () => typeof permissionScope.harnessId === "string" && typeof permissionScope.toolId === "string" && (permissionScope.capability === "network" || permissionScope.capability === "process" || permissionScope.capability === "workspace-write");
  const permissionValue = (grant: Record<string, unknown>) => ({ id: grant.provider_ref, scope: { harnessId: grant.harness_id, toolId: grant.tool_id, ...(grant.connection_ref ? { connectionId: grant.connection_ref } : {}), capability: grant.capability, ...(grant.resource_scope ? { resource: grant.resource_scope } : {}) }, effect: grant.effect, createdAt: grant.created_at, ...(grant.expires_at ? { expiresAt: grant.expires_at } : {}) });
  if (body.operation === "permissions.list") {
    if (typeof providerRequest.harnessId !== "string") return failure("Invalid permission list.");
    const grants = await supabase.from("permission_grants").select("provider_ref,harness_id,tool_id,connection_ref,capability,resource_scope,effect,created_at,expires_at").eq("user_id", userId).eq("harness_id", providerRequest.harnessId).or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    if (grants.error) return failure("Permission provider failed.", 502);
    return response((grants.data ?? []).map((grant) => permissionValue(grant)));
  }
  if (body.operation === "permissions.find") {
    if (!validScope()) return failure("Invalid permission scope.");
    let query = supabase.from("permission_grants").select("provider_ref,harness_id,tool_id,connection_ref,capability,resource_scope,effect,created_at,expires_at").eq("user_id", userId).eq("harness_id", permissionScope.harnessId).eq("tool_id", permissionScope.toolId).eq("capability", permissionScope.capability).eq("resource_scope", typeof permissionScope.resource === "string" ? permissionScope.resource : "");
    query = query.eq("connection_ref", typeof permissionScope.connectionId === "string" ? permissionScope.connectionId : "");
    const grant = await query.maybeSingle();
    if (grant.error) return failure("Permission provider failed.", 502);
    return response(grant.data ? permissionValue(grant.data) : null);
  }
  if (body.operation === "permissions.grant") {
    if (!validScope() || (providerRequest.effect !== "allow_always" && providerRequest.decision !== "allow_always")) return failure("Invalid permission grant.");
    const saved = await supabase.from("permission_grants").upsert({ user_id: userId, harness_id: permissionScope.harnessId, tool_id: permissionScope.toolId, connection_ref: typeof permissionScope.connectionId === "string" ? permissionScope.connectionId : "", capability: permissionScope.capability, resource_scope: typeof permissionScope.resource === "string" ? permissionScope.resource : "", effect: "allow_always" }, { onConflict: "user_id,harness_id,tool_id,capability,connection_ref,resource_scope" }).select("provider_ref,harness_id,tool_id,connection_ref,capability,resource_scope,effect,created_at,expires_at").single();
    if (saved.error) return failure("Permission write failed.", 502);
    return response(permissionValue(saved.data));
  }
  if (body.operation === "permissions.revoke") {
    if (typeof providerRequest.id !== "string") return failure("Invalid permission reference.");
    const deleted = await supabase.from("permission_grants").delete().eq("user_id", userId).eq("provider_ref", providerRequest.id).select("provider_ref").maybeSingle();
    if (deleted.error) return failure("Permission revoke failed.", 502);
    return response(Boolean(deleted.data));
  }

  if (body.operation === "connections.resolve") {
    if (typeof providerRequest.connectionId !== "string" || !["metadata", "provider", "tool"].includes(String(providerRequest.purpose))) return failure("Invalid connection resolution.");
    let connection = await supabase.from("connections").select("name,kind,public_config,status").eq("user_id", userId).eq("name", providerRequest.connectionId).eq("status", "ready").maybeSingle();
    if (!connection.error && !connection.data && process.env.ARC_SHARED_TEST_CONNECTIONS === "true") {
      connection = await supabase.from("connections").select("name,kind,public_config,status").eq("name", providerRequest.connectionId).eq("status", "ready").limit(1).maybeSingle();
    }
    if (connection.error) return failure("Connection provider failed.", 502);
    return response(connection.data ? { id: connection.data.name, kind: connection.data.kind, configuration: safeConfiguration(connection.data.public_config) } : null);
  }

  if (body.operation === "connections.fetch" || body.operation === "connections.execute") {
    if (typeof providerRequest.connectionId !== "string") return failure("Invalid connection operation.");
    let connection = await supabase.from("connections").select("id,public_config,status,vault_secret_id").eq("user_id", userId).eq("name", providerRequest.connectionId).eq("status", "ready").maybeSingle();
    if (!connection.error && !connection.data && process.env.ARC_SHARED_TEST_CONNECTIONS === "true") {
      connection = await supabase.from("connections").select("id,public_config,status,vault_secret_id").eq("name", providerRequest.connectionId).eq("status", "ready").limit(1).maybeSingle();
    }
    if (connection.error || !connection.data) return failure("Connection was not found.", 404);
    const config = record(connection.data.public_config) ?? {};
    if (typeof config.baseUrl !== "string") return failure("Connection has no reviewed base URL.", 409);
    const base = new URL(config.baseUrl);
    const loopback = base.hostname === "127.0.0.1" || base.hostname === "[::1]";
    if (base.username || base.password || base.hash || (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))) return failure("Connection URL is not allowed.", 409);
    let target: URL; let method = "POST"; let outboundBody: string | undefined; let requestedHeaders: Record<string, unknown> = {};
    if (body.operation === "connections.fetch") {
      if (typeof providerRequest.url !== "string") return failure("Invalid connection fetch.");
      target = new URL(providerRequest.url, base);
      const init = record(providerRequest.init) ?? {};
      method = typeof init.method === "string" ? init.method.toUpperCase() : "GET";
      requestedHeaders = record(init.headers) ?? {};
      outboundBody = typeof init.body === "string" ? init.body : undefined;
    } else {
      if (typeof providerRequest.action !== "string") return failure("Invalid connection action.");
      const operations = record(config.operations); const operation = record(operations?.[providerRequest.action]);
      if (!operation || typeof operation.path !== "string") return failure("Connection action is not allowlisted.", 403);
      target = new URL(operation.path, base);
      method = typeof operation.method === "string" ? operation.method.toUpperCase() : "POST";
      outboundBody = JSON.stringify(providerRequest.input ?? null);
    }
    if (!connectionTargetAllowed(base, target) || !["GET", "POST"].includes(method) || (outboundBody?.length ?? 0) > 1_048_576) return failure("Connection request is outside its reviewed scope.", 403);
    const headers = new Headers();
    for (const name of ["accept", "content-type"]) if (typeof requestedHeaders[name] === "string") headers.set(name, requestedHeaders[name] as string);
    if (outboundBody && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (connection.data.vault_secret_id) {
      const secret = await supabase.rpc("read_connection_secret", { p_connection_id: connection.data.id });
      if (secret.error || typeof secret.data !== "string") return failure("Connection credential is unavailable.", 502);
      const header = typeof config.credentialHeader === "string" && /^[A-Za-z0-9-]{1,64}$/u.test(config.credentialHeader) ? config.credentialHeader : "authorization";
      const scheme = typeof config.credentialScheme === "string" ? config.credentialScheme : "Bearer";
      const credential = connectionCredential(secret.data);
      headers.set(header, scheme ? `${scheme} ${credential}` : credential);
    }
    const outbound = await fetch(target, { method, headers, ...(outboundBody ? { body: outboundBody } : {}), signal: AbortSignal.timeout(30_000), redirect: "error" }).catch(() => undefined);
    if (!outbound) return failure("Connection request failed.", 502);
    const bytes = new Uint8Array(await outbound.arrayBuffer());
    if (bytes.byteLength > 4 * 1_048_576) return failure("Connection response exceeds 4 MiB.", 502);
    if (body.operation === "connections.execute") {
      if (!outbound.ok) return failure(`Connection action failed with HTTP ${outbound.status}.`, 502);
      const text = new TextDecoder().decode(bytes);
      if (outbound.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        try { return response(JSON.parse(text) as unknown); }
        catch { return failure("Connection returned invalid JSON.", 502); }
      }
      return response(text);
    }
    return response({ status: outbound.status, headers: { "content-type": outbound.headers.get("content-type") ?? "application/octet-stream" }, bodyBase64: Buffer.from(bytes).toString("base64") });
  }

  if (body.operation === "file.read") {
    if (typeof providerRequest.ref !== "string") return failure("Invalid file reference.");
    const selected = /^f\.([0-9a-f-]{36})\.(\d{1,3})$/iu.exec(providerRequest.ref);
    if (selected?.[1] === contextRef) {
      const index = Number(selected[2]); const fileId = (fileIds as string[])[index];
      if (!fileId) return failure("File reference was not found.", 404);
      const file = await supabase.from("files").select("name,mime_type,size_bytes,sha256,status").eq("id", fileId).eq("user_id", userId).single();
      if (file.error || !file.data.sha256 || file.data.status === "deleted") return failure("File reference was not found.", 404);
      return response({ file: { ref: providerRequest.ref, name: file.data.name, mimeType: file.data.mime_type, size: file.data.size_bytes, sha256: file.data.sha256 }, url: `/api/internal/providers/files/${encodeURIComponent(providerRequest.ref)}` });
    }
    const artifactMatch = /^a\.([0-9a-f-]{36})\.([a-f0-9]{36})$/iu.exec(providerRequest.ref);
    if (artifactMatch?.[1] !== contextRef) return failure("File reference was not found.", 404);
    const upload = await supabase.from("provider_file_uploads").select("artifact_id").eq("provider_ref", artifactMatch[2]).eq("context_ref", contextRef).eq("user_id", userId).eq("status", "committed").single();
    if (upload.error || !upload.data.artifact_id) return failure("File reference was not found.", 404);
    const artifact = await supabase.from("artifacts").select("name,mime_type,size_bytes,sha256,status").eq("id", upload.data.artifact_id).eq("user_id", userId).single();
    if (artifact.error || artifact.data.status !== "ready") return failure("File reference was not found.", 404);
    return response({ file: { ref: providerRequest.ref, name: artifact.data.name, mimeType: artifact.data.mime_type, size: artifact.data.size_bytes, sha256: artifact.data.sha256 }, url: `/api/internal/providers/files/${encodeURIComponent(providerRequest.ref)}` });
  }

  if (body.operation === "file.create") {
    if (typeof providerRequest.name !== "string" || providerRequest.name.length < 1 || providerRequest.name.length > 255 || typeof providerRequest.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/u.test(providerRequest.mimeType)) return failure("Invalid file creation request.");
    const created = await supabase.from("provider_file_uploads").insert({ user_id: userId, conversation_id: conversationId, context_ref: contextRef, name: providerRequest.name, mime_type: providerRequest.mimeType, metadata: record(providerRequest.metadata) ?? {} }).select("provider_ref").single();
    if (created.error) return failure("File creation failed.", 502);
    return response({ ref: `u.${created.data.provider_ref}` });
  }

  if (body.operation === "file.commit") {
    const uploadRef = typeof providerRequest.ref === "string" ? /^u\.([a-f0-9]{36})$/iu.exec(providerRequest.ref) : null;
    if (!uploadRef || typeof providerRequest.dataBase64 !== "string" || providerRequest.dataBase64.length > 45_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(providerRequest.dataBase64)) return failure("Invalid file commit.");
    const bytes = Buffer.from(providerRequest.dataBase64, "base64");
    if (!bytes.length || bytes.byteLength > 32 * 1_048_576) return failure("File exceeds the 32 MiB provider limit.", 413);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const expected = { size: bytes.byteLength, sha256 };
    const claimed = await supabase.rpc("claim_provider_file_upload", { p_provider_ref: uploadRef[1], p_context_ref: contextRef, p_user_id: userId, p_size: expected.size, p_sha256: expected.sha256 });
    const claim = record(claimed.data);
    if (claimed.error || !claim || claim.status === "missing") return failure("File upload is missing or expired.", 404);
    if (claim.status === "mismatch") return failure("File commit does not match the original upload.", 409);
    const result = (value: Record<string, unknown>) => response({ ref: `a.${contextRef}.${String(value.providerRef)}`, name: value.name, mimeType: value.mimeType, size: value.size, sha256: value.sha256, metadata: record(value.metadata) ?? {} });
    if (claim.status === "committed") return result(claim);
    if (claim.status !== "ready" || typeof claim.name !== "string" || typeof claim.mimeType !== "string") return failure("File upload is unavailable.", 409);
    const path = providerArtifactPath(userId, conversationId, uploadRef[1], claim.name);
    const cleanup = async () => {
      const removed = await supabase.storage.from("artifacts").remove([path]);
      if (removed.error) return false;
      const failed = await supabase.rpc("fail_provider_file_upload", { p_provider_ref: uploadRef[1], p_context_ref: contextRef, p_user_id: userId, p_storage_path: path });
      return !failed.error && failed.data === true;
    };
    const stored = await supabase.storage.from("artifacts").upload(path, bytes, { contentType: claim.mimeType, upsert: false });
    if (stored.error) {
      const existing = await supabase.storage.from("artifacts").download(path);
      if (existing.error) return failure("Artifact storage failed.", 502);
      const existingBytes = new Uint8Array(await existing.data.arrayBuffer());
      const existingFile = { size: existingBytes.byteLength, sha256: createHash("sha256").update(existingBytes).digest("hex") };
      if (!sameFile(existingFile, expected)) {
        return await cleanup() ? failure("Stored artifact does not match the committed bytes.", 409) : failure("Artifact cleanup failed.", 502);
      }
    }
    const finalized = await supabase.rpc("finalize_provider_file_upload", {
      p_provider_ref: uploadRef[1], p_context_ref: contextRef, p_user_id: userId, p_storage_path: path,
      p_size: expected.size, p_sha256: expected.sha256, p_metadata: record(providerRequest.metadata) ?? {},
    });
    const committed = record(finalized.data);
    if (finalized.error || !committed) return failure("Artifact commit failed.", 502);
    if (committed.status !== "committed") {
      return await cleanup() ? failure("Artifact commit conflicts with stored metadata.", 409) : failure("Artifact cleanup failed.", 502);
    }
    return result(committed);
  }

  if (body.operation === "files.list") {
    const selected = (fileIds as string[]).slice(offset, offset + limit + 1);
    const files = selected.length ? await supabase.from("files").select("id,name,mime_type,size_bytes,sha256,status,updated_at").eq("user_id", userId).in("id", selected) : { data: [], error: null };
    if (files.error) return failure("File provider failed.", 502);
    const byId = new Map((files.data ?? []).map((file) => [file.id, file]));
    const rows = selected.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
    return response({ revision: rows[0]?.updated_at ?? "empty", files: rows.slice(0, limit).map((file, index) => ({ ref: `f.${contextRef}.${offset + index}`, name: file.name, mimeType: file.mime_type, size: file.size_bytes, sha256: file.sha256, status: file.status })), cursor: nextProviderCursor(offset, selected.length, limit) });
  }

  return failure("Unknown provider operation.");
}
