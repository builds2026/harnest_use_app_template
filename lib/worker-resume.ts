import { randomUUID } from "node:crypto";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function prepareResume(
  payload: Record<string, unknown>,
  fromRunId: string,
  createKey: () => string = randomUUID,
) {
  const pending = record(payload.harnestResume);
  if (pending?.fromRunId === fromRunId && typeof pending.key === "string" && pending.key.length <= 512) {
    return { payload, key: pending.key };
  }
  const key = createKey();
  return { payload: { ...payload, harnestResume: { fromRunId, key } }, key };
}

export function finishResume(payload: Record<string, unknown>) {
  const { harnestResume: _pending, ...rest } = payload;
  void _pending;
  return rest;
}
