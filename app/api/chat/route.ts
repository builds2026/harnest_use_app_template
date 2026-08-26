import { deterministicReply, localDemoEnabled } from "@/lib/demo";
import { runEventLabel, sse } from "@/lib/harnest";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{8,64}$/iu.test(value);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const outputText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

function streamResponse(run: (send: (event: unknown) => void) => Promise<void>) {
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(sse(event)));
      try { await run(send); } catch (error) { send({ type: "error", message: error instanceof Error ? error.message : "Run failed" }); }
      finally { controller.close(); }
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}

export async function POST(request: Request) {
  let body: { message?: unknown; conversationId?: unknown; fileIds?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const fileIds = Array.isArray(body.fileIds) ? [...new Set(body.fileIds.filter(isId))].slice(0, 10) : [];
  if (!message || message.length > 32_000) return Response.json({ error: "Message must contain 1–32,000 characters." }, { status: 400 });

  if (localDemoEnabled()) return streamResponse(async (send) => {
    const runId = crypto.randomUUID();
    send({ type: "status", runId, phase: "classifying", label: "Classifying request" });
    await sleep(120);
    send({ type: "status", runId, phase: "working", label: "Deterministic local path" });
    const reply = deterministicReply(message);
    for (const part of reply.match(/.{1,18}(?:\s|$)/gu) ?? [reply]) { send({ type: "delta", text: part }); await sleep(18); }
    send({ type: "done", runId, output: reply, mode: "demo" });
  });

  if (!supabaseConfigured()) return Response.json({ error: "Supabase is not configured." }, { status: 503 });
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const rate = await supabase.rpc("consume_rate_limit", { p_key: "chat", p_limit: 20, p_window_seconds: 60 });
  if (rate.error || rate.data !== true) return Response.json({ error: "Rate limit exceeded. Try again shortly." }, { status: 429 });

  let conversationId = isId(body.conversationId) ? body.conversationId : undefined;
  if (!conversationId) {
    const created = await supabase.from("conversations").insert({ user_id: user.id, title: message.slice(0, 72) }).select("id").single();
    if (created.error) return Response.json({ error: created.error.message }, { status: 400 });
    conversationId = created.data.id;
  }
  const admin = createSupabaseAdmin();
  const runId = crypto.randomUUID();
  const queued = await admin.rpc("enqueue_chat", {
    p_user_id: user.id, p_conversation_id: conversationId, p_message: message,
    p_file_ids: fileIds, p_run_id: runId,
  });
  if (queued.error) return Response.json({ error: queued.error.message }, { status: queued.error.code === "42501" ? 403 : 400 });

  const ownedConversationId = conversationId;
  if (request.headers.get("accept")?.includes("application/json")) return Response.json({ runId, conversationId: ownedConversationId, status: "queued" }, { status: 202 });
  return streamResponse(async (send) => {
    send({ type: "status", runId, conversationId: ownedConversationId, phase: "queued", label: "Waiting for worker" });
    let after = 0;
    for (let poll = 0; !request.signal.aborted; poll += 1) {
      const [events, currentRun] = await Promise.all([
        supabase.from("events").select("sequence,type,payload,status").eq("run_id", runId).gt("sequence", after).order("sequence").limit(100),
        supabase.from("runs").select("status,output,error").eq("id", runId).single(),
      ]);
      if (events.error || currentRun.error) throw new Error(events.error?.message ?? currentRun.error?.message ?? "Could not read run state");
      for (const row of events.data ?? []) {
        after = row.sequence;
        const payload = row.payload as Record<string, unknown>;
        if (row.type === "text.delta" && typeof payload.text === "string") send({ type: "delta", text: payload.text });
        else if (row.type === "interaction.requested") send({ type: "interaction", state: "waiting", label: String((payload.interaction as { title?: unknown } | undefined)?.title ?? "Input required"), request: payload.interaction });
        else if (row.type !== "run.snapshot") send({ type: "status", phase: row.type, label: runEventLabel(row.type, payload), event: payload });
      }
      if (currentRun.data.status === "succeeded") {
        send({ type: "done", runId, conversationId: ownedConversationId, output: outputText(currentRun.data.output) }); return;
      }
      if (currentRun.data.status === "waiting") { send({ type: "status", runId, phase: "waiting", label: "Waiting for interaction" }); return; }
      if (["failed", "cancelled"].includes(currentRun.data.status)) throw new Error(currentRun.data.error ?? `Run ${currentRun.data.status}`);
      if (poll > 0 && poll % 30 === 0) send({ type: "status", runId, phase: "heartbeat", label: "Run is active" });
      await sleep(500);
    }
  });
}
