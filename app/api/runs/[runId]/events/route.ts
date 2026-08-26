import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";
import { runEventLabel } from "@/lib/harnest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (event: unknown, id?: number) => `${id === undefined ? "" : `id: ${id}\n`}event: message\ndata: ${JSON.stringify(event)}\n\n`;

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!supabaseConfigured()) return Response.json({ error: "Supabase is not configured." }, { status: 503 });
  const { runId } = await context.params;
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) return Response.json({ error: "Invalid run id." }, { status: 400 });
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const owned = await supabase.from("runs").select("id").eq("id", runId).eq("user_id", user.id).single();
  if (owned.error) return Response.json({ error: "Run not found." }, { status: 404 });
  const requestedAfter = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0);
  let after = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0;
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (event: unknown, id?: number) => controller.enqueue(encoder.encode(frame(event, id)));
      try {
        controller.enqueue(encoder.encode("retry: 3000\n\n"));
        send({ type: "status", runId, phase: "reconnecting", label: "Reconnected to durable run" });
        let polls = 0;
        while (!request.signal.aborted) {
          const [events, run] = await Promise.all([
            supabase.from("events").select("sequence,type,payload").eq("run_id", runId).gt("sequence", after).order("sequence").limit(100),
            supabase.from("runs").select("status,output,error,conversation_id").eq("id", runId).eq("user_id", user.id).single(),
          ]);
          if (events.error || run.error) throw new Error(events.error?.message ?? run.error?.message ?? "Run replay failed");
          for (const row of events.data ?? []) {
            after = row.sequence;
            const payload = row.payload as Record<string, unknown>;
            if (row.type === "text.delta" && typeof payload.text === "string") send({ type: "delta", text: payload.text }, row.sequence);
            else if (row.type === "interaction.requested") send({ type: "interaction", runId, label: String((payload.interaction as { title?: unknown } | undefined)?.title ?? "Input required"), request: payload.interaction }, row.sequence);
            else if (row.type !== "run.snapshot") send({ type: "status", runId, phase: row.type, label: runEventLabel(row.type, payload), event: payload }, row.sequence);
          }
          if (run.data.status === "succeeded") { send({ type: "done", runId, conversationId: run.data.conversation_id, output: typeof run.data.output === "string" ? run.data.output : JSON.stringify(run.data.output) }); break; }
          if (run.data.status === "failed" || run.data.status === "cancelled") { send({ type: "error", message: run.data.error ?? `Run ${run.data.status}` }); break; }
          if (run.data.status === "waiting") { send({ type: "status", runId, phase: "waiting", label: "Waiting for interaction" }); break; }
          polls += 1;
          if (polls % 30 === 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          await sleep(500);
        }
      } catch (error) { send({ type: "error", message: error instanceof Error ? error.message : "Run replay failed" }); }
      finally { controller.close(); }
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
