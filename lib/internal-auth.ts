import { timingSafeEqual } from "node:crypto";

export function internalRequestAuthorized(request: Request) {
  const expected = process.env.PROVIDER_BRIDGE_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
  if (!expected) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
