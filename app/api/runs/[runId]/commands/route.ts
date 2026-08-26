import { InteractionResponseSchema, RunCommandSchema } from "@harnestai/protocol";
import { HarnestError } from "@harnestai/sdk";
import { harnestClient } from "@/lib/harnest";
import { retrySafeCommand, runCommandKey } from "@/lib/run-command";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

const id = (value: string) => /^[0-9a-f-]{8,64}$/iu.test(value);

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!supabaseConfigured()) return Response.json({ error: "Supabase is not configured." }, { status: 503 });
  const { runId } = await context.params;
  if (!id(runId)) return Response.json({ error: "Invalid run id." }, { status: 400 });
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const run = await supabase.from("runs").select("external_run_id,status").eq("id", runId).single();
  if (run.error || !run.data.external_run_id) return Response.json({ error: "Run is not controllable yet." }, { status: 409 });
  const body = await request.json().catch(() => undefined) as { response?: unknown; command?: unknown; cancel?: unknown } | undefined;
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid command." }, { status: 400 });
  const actions = Number(body.cancel === true) + Number(body.response !== undefined) + Number(body.command !== undefined);
  if (actions !== 1) return Response.json({ error: "Exactly one response, command, or cancel action is required." }, { status: 400 });
  if (["succeeded", "failed", "cancelled"].includes(run.data.status)) return Response.json({ error: `Run is already ${run.data.status}.` }, { status: 409 });
  const parsedResponse = body.response !== undefined ? InteractionResponseSchema.safeParse(body.response) : undefined;
  const parsedCommand = body.command !== undefined ? RunCommandSchema.safeParse(body.command) : undefined;
  if (parsedResponse && !parsedResponse.success || parsedCommand && !parsedCommand.success) return Response.json({ error: "Invalid run command." }, { status: 400 });
  const sdk = harnestClient();
  const admin = createSupabaseAdmin();
  try {
    if (body.cancel === true) {
      await sdk.cancel(run.data.external_run_id, request.signal);
      const cancelled = await admin.from("runs").update({ status: "cancelled" }).eq("id", runId).eq("user_id", user.id).in("status", ["queued", "running", "waiting"]);
      if (cancelled.error) throw cancelled.error;
      return Response.json({ ok: true });
    }
    const commandKey = runCommandKey(parsedResponse?.success ? { response: parsedResponse.data } : { command: parsedCommand?.data });
    const begun = await admin.rpc("begin_run_command", { p_run_id: runId, p_user_id: user.id, p_command_key: commandKey });
    if (begun.error) throw begun.error;
    if (begun.data === "accepted") return Response.json({ ok: true, duplicate: true });
    if (begun.data !== "ready") throw new Error(begun.data === "busy" ? "Another command is being processed." : begun.data === "terminal" ? "Run is already terminal." : "Run is not waiting for a command.");
    try {
      if (parsedResponse?.success) await sdk.respond(run.data.external_run_id, parsedResponse.data, request.signal);
      else if (parsedCommand?.success) await sdk.command(run.data.external_run_id, retrySafeCommand(parsedCommand.data, commandKey), request.signal);
    } catch (error) {
      if (error instanceof HarnestError && error.status >= 400 && error.status < 500) await admin.rpc("reject_run_command", { p_run_id: runId, p_user_id: user.id, p_command_key: commandKey });
      throw error;
    }
    const accepted = await admin.rpc("accept_run_command", { p_run_id: runId, p_user_id: user.id, p_command_key: commandKey });
    if (accepted.error || accepted.data !== true) throw accepted.error ?? new Error("Run command could not be committed.");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Command was rejected." }, { status: 409 });
  }
}
