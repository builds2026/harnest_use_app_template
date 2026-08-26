import { WireEnvelopeSchema, type WireEnvelope } from "@harnestai/protocol";
import { internalRequestAuthorized } from "@/lib/internal-auth";
import { publicHarnestEvent } from "@/lib/harnest";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { finishResume, prepareResume } from "@/lib/worker-resume";

export const runtime = "nodejs";
const workerId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const ref = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
const externalRunId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function leasedJob(jobRef: string, owner: string) {
  return createSupabaseAdmin().from("jobs").select("id,user_id,conversation_id,run_id,payload").eq("id", jobRef).eq("lease_owner", owner).eq("status", "leased").gt("lease_expires_at", new Date().toISOString()).single();
}

async function persist(jobRef: string, owner: string, event: WireEnvelope) {
  const supabase = createSupabaseAdmin();
  const data = record(event.data) ?? {};
  const payload = { ...publicHarnestEvent(event, process.env.HARNEST_PUBLIC_NODE_ID ?? "answer"), label: event.type };
  const artifact = record(data.artifact);
  const artifacts = (Array.isArray(data.artifacts) ? data.artifacts : artifact ? [artifact] : []).flatMap((value) => {
    const item = record(value);
    return item && typeof item.name === "string" && typeof item.sha256 === "string" ? [{ name: item.name, sha256: item.sha256, ...(typeof item.ref === "string" ? { ref: item.ref } : {}) }] : [];
  });
  const citations = (Array.isArray(data.citations) ? data.citations : []).flatMap((value) => {
    const item = record(value); const provenance = record(item?.provenance);
    return item && typeof item.label === "string" ? [{ label: item.label, provenance: {
      ...(typeof provenance?.title === "string" ? { title: provenance.title.slice(0, 300) } : {}),
      ...(typeof provenance?.uri === "string" ? { uri: provenance.uri.slice(0, 2_000) } : {}),
      ...(typeof provenance?.source === "string" ? { source: provenance.source.slice(0, 100) } : {}),
    } }] : [];
  });
  const output = data.output;
  const projection = {
    ...(event.type === "run.snapshot" ? { revision: typeof data.revision === "number" ? data.revision : event.sequence, state: data } : {}),
    ...(event.type === "run.failed" ? { error: typeof data.message === "string" ? data.message : "Harnest run failed" } : {}),
    ...(event.type === "run.completed" ? {
      output, content: typeof output === "string" ? output : JSON.stringify(output), usage: record(data.usage) ?? {},
      ...(typeof data.costUsd === "number" && Number.isFinite(data.costUsd) ? { costUsd: data.costUsd } : {}),
    } : {}),
    ...(artifacts.length ? { artifacts } : {}), ...(citations.length ? { citations } : {}),
  };
  const saved = await supabase.rpc("persist_worker_event", {
    p_job_id: jobRef, p_worker_id: owner, p_sequence: event.sequence, p_type: event.type,
    p_status: event.type === "run.failed" ? "failed" : event.type === "interaction.requested" ? "waiting" : "complete",
    p_payload: payload, p_projection: projection,
  });
  if (saved.error || saved.data !== true) throw saved.error ?? new Error("Event persistence failed");
}

export async function POST(request: Request) {
  if (!internalRequestAuthorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!body || !workerId(body.workerId)) return Response.json({ error: "Invalid worker request." }, { status: 400 });
  const supabase = createSupabaseAdmin();
  try {
    if (body.action === "lease") {
      const leased = await supabase.rpc("lease_jobs", { p_worker_id: body.workerId, p_limit: 1, p_lease_seconds: 90 });
      if (leased.error) throw leased.error;
      const job = leased.data?.[0];
      if (!job) return Response.json({ job: null });
      const input = record(job.payload);
      if (job.kind !== "harnest-run" || !input || typeof input.message !== "string" || typeof input.contextRef !== "string" || !job.run_id) throw new Error("Leased job payload is unsupported");
      const context = await supabase.from("context_refs").select("user_id,conversation_id,file_ids").eq("id", input.contextRef).eq("user_id", job.user_id).single();
      if (context.error) throw context.error;
      const [run, last, conversationRevision, memoryRevision, pkmRevision, files] = await Promise.all([
        supabase.from("runs").select("external_run_id").eq("id", job.run_id).single(),
        supabase.from("events").select("sequence").eq("run_id", job.run_id).order("sequence", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("conversations").select("updated_at").eq("id", context.data.conversation_id).eq("user_id", context.data.user_id).single(),
        supabase.from("memories").select("updated_at").eq("user_id", context.data.user_id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("pkm_chunks").select("updated_at").eq("user_id", context.data.user_id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        context.data.file_ids.length ? supabase.from("files").select("id,name,mime_type,size_bytes,sha256").eq("user_id", context.data.user_id).in("id", context.data.file_ids) : Promise.resolve({ data: [], error: null }),
      ]);
      const queryError = run.error ?? last.error ?? conversationRevision.error ?? memoryRevision.error ?? pkmRevision.error ?? files.error;
      if (queryError || !run.data || !conversationRevision.data) throw queryError ?? new Error("Leased job references are incomplete");
      const byId = new Map((files.data ?? []).map((file) => [file.id, file]));
      const attachments = (context.data.file_ids as string[]).flatMap((id, index) => {
        const file = byId.get(id);
        return file?.sha256 ? [{ ref: `f.${input.contextRef}.${index}`, name: file.name, mimeType: file.mime_type, size: file.size_bytes, sha256: file.sha256 }] : [];
      });
      return Response.json({ job: {
        ref: job.id, input: { message: input.message },
        context: { contextRef: input.contextRef, revisions: { conversation: conversationRevision.data.updated_at, memory: memoryRevision.data?.updated_at ?? "empty", pkm: pkmRevision.data?.updated_at ?? "empty" }, attachments },
        externalRunId: run.data.external_run_id, after: last.data?.sequence ?? 0,
      } });
    }
    if (!ref(body.jobRef)) return Response.json({ error: "Invalid job reference." }, { status: 400 });
    if (body.action === "renew") {
      const renewed = await supabase.rpc("renew_job_lease", { p_job_id: body.jobRef, p_worker_id: body.workerId, p_lease_seconds: 90 });
      if (renewed.error || renewed.data !== true) throw renewed.error ?? new Error("Job lease renewal failed");
      return Response.json({ ok: true });
    }
    if (body.action === "prepareResume" && externalRunId(body.externalRunId)) {
      const job = await leasedJob(body.jobRef, body.workerId);
      if (job.error) throw new Error("Job lease is invalid or expired");
      const prepared = prepareResume(record(job.data.payload) ?? {}, body.externalRunId);
      const saved = await supabase.from("jobs").update({ payload: prepared.payload })
        .eq("id", body.jobRef).eq("lease_owner", body.workerId).eq("status", "leased").select("id").single();
      if (saved.error) throw saved.error;
      return Response.json({ resumeKey: prepared.key });
    }
    if (body.action === "start" && externalRunId(body.externalRunId)) {
      const job = await leasedJob(body.jobRef, body.workerId);
      if (job.error || !job.data.run_id) throw new Error("Job lease is invalid or expired");
      const started = await supabase.from("runs").update({ external_run_id: body.externalRunId, status: "running", started_at: new Date().toISOString() }).eq("id", job.data.run_id);
      if (started.error) throw started.error;
      const payload = record(job.data.payload) ?? {};
      if (payload.harnestResume !== undefined) {
        const cleared = await supabase.from("jobs").update({ payload: finishResume(payload) })
          .eq("id", body.jobRef).eq("lease_owner", body.workerId).eq("status", "leased").select("id").single();
        if (cleared.error) throw cleared.error;
      }
      return Response.json({ ok: true });
    }
    if (body.action === "event") {
      const event = WireEnvelopeSchema.parse(body.event);
      await persist(body.jobRef, body.workerId, event);
      return Response.json({ ok: true });
    }
    if (body.action === "finish" && typeof body.succeeded === "boolean") {
      const finished = await supabase.rpc("finish_job", { p_job_id: body.jobRef, p_worker_id: body.workerId, p_succeeded: body.succeeded, p_error: typeof body.error === "string" ? body.error : null });
      if (finished.error || finished.data !== true) throw finished.error ?? new Error("Job finish failed");
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unknown worker action." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Worker request failed." }, { status: 409 });
  }
}
