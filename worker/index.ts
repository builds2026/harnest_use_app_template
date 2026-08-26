import { HarnestClient, HarnestError, type CreateRunContext } from "@harnestai/sdk";

interface LeasedJob {
  ref: string;
  input: { message: string };
  context: CreateRunContext;
  externalRunId?: string;
  after: number;
}

const internalUrl = process.env.NEXTJS_INTERNAL_URL;
const bridgeToken = process.env.PROVIDER_BRIDGE_TOKEN;
const harnestUrl = process.env.HARNEST_URL ?? "";
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
if (!internalUrl || !bridgeToken || !harnestUrl) {
  throw new Error("Worker requires NEXTJS_INTERNAL_URL, PROVIDER_BRIDGE_TOKEN, and HARNEST_URL");
}

async function appRequest<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(new URL("/api/internal/worker", internalUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, workerId }),
  });
  const result = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(result.error ?? `Internal app API returned ${response.status}`);
  return result;
}

async function run(job: LeasedJob) {
  const sdk = new HarnestClient({ baseUrl: harnestUrl, token: process.env.HARNEST_TOKEN });
  let externalRunId = job.externalRunId ?? (await sdk.create(job.input.message, { context: job.context, idempotencyKey: job.ref })).runId;
  await appRequest({ action: "start", jobRef: job.ref, externalRunId });
  let terminal = false;
  let after = job.after;
  let reviveAttempts = 0;
  const revive = async () => {
    if (reviveAttempts >= 3) throw new Error("Harnest run recovery exceeded three attempts");
    reviveAttempts += 1;
    const { resumeKey } = await appRequest<{ resumeKey: string }>({ action: "prepareResume", jobRef: job.ref, externalRunId });
    externalRunId = (await sdk.create(job.input.message, { resumeRunId: externalRunId, context: job.context, idempotencyKey: resumeKey })).runId;
    await appRequest({ action: "start", jobRef: job.ref, externalRunId });
  };
  while (!terminal) {
    let paused = false;
    try {
      for await (const event of sdk.events(externalRunId, { after })) {
        after = event.sequence;
        await appRequest({ action: "event", jobRef: job.ref, event });
        if (event.type === "run.paused") paused = true;
        else if (event.type === "run.resumed") paused = false;
        if (event.type === "run.failed") {
          const data = typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : {};
          throw new Error(typeof data.message === "string" ? data.message : "Harnest run failed");
        }
        if (event.type === "run.completed" || event.type === "run.cancelled") terminal = true;
      }
    } catch (error) {
      if (error instanceof HarnestError && (error.status === 404 || error.code === "RUN_RECOVERY_REQUIRED")) {
        await revive();
        continue;
      }
      throw error;
    }
    if (terminal) continue;
    const state = await sdk.snapshotState(externalRunId);
    if (state.active) await new Promise((resolve) => setTimeout(resolve, paused ? 1_000 : 250));
    else if (state.snapshot.status === "paused" || state.snapshot.status === "running") await revive();
    else throw new Error(`Harnest event stream ended with ${String(state.snapshot.status)}`);
  }
}

console.log(`Worker ${workerId} ready`);
while (true) {
  let job: LeasedJob | null;
  try { ({ job } = await appRequest<{ job: LeasedJob | null }>({ action: "lease" })); }
  catch (error) {
    console.error("Worker bridge unavailable; retrying", error instanceof Error ? error.message : error);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    continue;
  }
  if (job) {
    const renewal = setInterval(() => {
      void appRequest({ action: "renew", jobRef: job.ref }).catch((error) => console.error("Lease renewal failed", error));
    }, 30_000);
    try {
      await run(job);
      await appRequest({ action: "finish", jobRef: job.ref, succeeded: true });
    } catch (error) {
      await appRequest({ action: "finish", jobRef: job.ref, succeeded: false, error: error instanceof Error ? error.message : "Job failed" })
        .catch((finishError) => console.error("Job finish failed", finishError));
    } finally {
      clearInterval(renewal);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, job ? 100 : 2_000));
}
