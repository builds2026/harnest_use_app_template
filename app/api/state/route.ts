import { NextResponse } from "next/server";
import { demoState, localDemoEnabled } from "@/lib/demo";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";
import type { AppState } from "@/lib/types";
import { runEventLabel } from "@/lib/harnest";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (localDemoEnabled()) return NextResponse.json(demoState(), { headers: { "cache-control": "no-store" } });
  if (!supabaseConfigured()) {
    return NextResponse.json({
      mode: "setup", setup: { missing: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] },
      conversations: [], messages: [], files: [], artifacts: [], memories: [], pkmSources: [], citations: [], trace: [], permissions: [], connections: [],
    } satisfies AppState, { status: 503 });
  }

  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in with Supabase Auth to continue." }, { status: 401 });

  const requestedId = new URL(request.url).searchParams.get("conversation");
  const { data: rows, error } = await supabase.from("conversations")
    .select("id,title,updated_at,messages(content,created_at)")
    .order("updated_at", { ascending: false }).limit(40);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const conversations = (rows ?? []).map((row) => {
    const messages = Array.isArray(row.messages) ? row.messages : [];
    const latest = [...messages].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    return { id: row.id, title: row.title, preview: latest?.content ?? "New conversation", updatedAt: row.updated_at };
  });
  const activeConversationId = requestedId ?? conversations[0]?.id;

  const [messageResult, fileResult, artifactResult, memoryResult, sourceResult, citationResult, eventResult, permissionResult, connectionResult] = await Promise.all([
    activeConversationId ? supabase.from("messages").select("id,role,content,created_at").eq("conversation_id", activeConversationId).order("created_at") : Promise.resolve({ data: [] }),
    activeConversationId ? supabase.from("files").select("id,name,mime_type,size_bytes,sha256,status").eq("conversation_id", activeConversationId).order("created_at") : Promise.resolve({ data: [] }),
    activeConversationId ? supabase.from("artifacts").select("id,name,mime_type,size_bytes,status,kind,summary,created_at").eq("conversation_id", activeConversationId).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    supabase.from("memories").select("id,key,value,updated_at").order("updated_at", { ascending: false }).limit(25),
    supabase.from("pkm_sources").select("id,title,kind,status").order("updated_at", { ascending: false }).limit(25),
    activeConversationId ? supabase.from("citations").select("id,title,url,excerpt,citation_index").eq("conversation_id", activeConversationId).order("citation_index") : Promise.resolve({ data: [] }),
    activeConversationId ? supabase.from("events").select("id,type,payload,status,created_at").eq("conversation_id", activeConversationId).neq("type", "run.snapshot").order("sequence", { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
    supabase.from("permission_grants").select("provider_ref,harness_id,tool_id,capability,resource_scope").or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).order("updated_at", { ascending: false }),
    supabase.from("connections").select("name,kind,status,last_error,updated_at").order("updated_at", { ascending: false }),
  ]);
  const activeRunResult = activeConversationId ? await supabase.from("runs").select("id,status").eq("conversation_id", activeConversationId).in("status", ["queued", "running", "waiting"]).order("created_at", { ascending: false }).limit(1).maybeSingle() : { data: null };
  const interactionResult = activeRunResult.data ? await supabase.from("events").select("type,payload").eq("run_id", activeRunResult.data.id).in("type", ["interaction.requested", "interaction.resolved"]).order("sequence").limit(500) : { data: [] };
  const pendingInteractions = new Map<string, Record<string, unknown>>();
  for (const event of interactionResult.data ?? []) {
    const payload = event.payload as { interaction?: Record<string, unknown>; interactionId?: unknown };
    if (event.type === "interaction.requested" && typeof payload.interaction?.id === "string") pendingInteractions.set(payload.interaction.id, payload.interaction);
    if (event.type === "interaction.resolved" && typeof payload.interactionId === "string") pendingInteractions.delete(payload.interactionId);
  }

  return NextResponse.json({
    mode: "production", user: { id: user.id, email: user.email }, conversations, activeConversationId,
    setup: { missing: ["gemini-main", "search-main"].filter((name) => !(connectionResult.data ?? []).some((row) => row.name === name && row.status === "ready")) },
    ...(activeRunResult.data ? { activeRun: { id: activeRunResult.data.id, status: activeRunResult.data.status, interactions: [...pendingInteractions.values()] } } : {}),
    messages: (messageResult.data ?? []).map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: row.created_at })),
    files: (fileResult.data ?? []).map((row) => ({ id: row.id, name: row.name, mimeType: row.mime_type, size: row.size_bytes, sha256: row.sha256 ?? undefined, status: row.status })),
    artifacts: (artifactResult.data ?? []).map((row) => ({ id: row.id, name: row.name, mimeType: row.mime_type, size: row.size_bytes, status: row.status, kind: row.kind, summary: row.summary, createdAt: row.created_at })),
    memories: (memoryResult.data ?? []).map((row) => ({ id: row.id, key: row.key, value: JSON.stringify(row.value), updatedAt: row.updated_at })),
    pkmSources: (sourceResult.data ?? []).map((row) => ({ id: row.id, title: row.title, kind: row.kind, status: row.status })),
    citations: (citationResult.data ?? []).map((row) => ({ id: row.id, title: row.title, url: row.url, excerpt: row.excerpt, index: row.citation_index })),
    trace: (eventResult.data ?? []).reverse().map((row) => ({ id: row.id, type: row.type, label: runEventLabel(row.type, row.payload as Record<string, unknown>), status: row.status, at: row.created_at })),
    permissions: (permissionResult.data ?? []).map((row) => ({ id: row.provider_ref, harnessId: row.harness_id, toolId: row.tool_id, capability: row.capability, ...(row.resource_scope ? { resource: row.resource_scope } : {}) })),
    connections: (connectionResult.data ?? []).map((row) => ({ name: row.name, kind: row.kind, status: row.status, ...(row.last_error ? { lastError: row.last_error } : {}), updatedAt: row.updated_at })),
  } satisfies AppState, { headers: { "cache-control": "private, no-store" } });
}
