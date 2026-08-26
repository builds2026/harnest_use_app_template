import assert from "node:assert/strict";
import test from "node:test";
import { authInput, signupError } from "../lib/auth";

test("auth input normalizes valid credentials and rejects unsafe bounds", () => {
  assert.deepEqual(authInput({ mode: "login", email: " USER@Example.com ", password: "long-enough" }), { mode: "login", email: "user@example.com", password: "long-enough" });
  assert.deepEqual(authInput({ mode: "signup", email: "bad", password: "short" }), { error: "올바른 이메일 주소를 입력하세요." });
  assert.deepEqual(authInput({ mode: "signup", email: "user@example.com", password: "short" }), { error: "비밀번호는 8~128자로 입력하세요." });
});

test("signup rate limits produce an actionable message", () => {
  assert.match(signupError("over_email_send_rate_limit", "email rate limit exceeded"), /SMTP/u);
});
