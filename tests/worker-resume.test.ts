import assert from "node:assert/strict";
import test from "node:test";
import { finishResume, prepareResume } from "../lib/worker-resume";

test("a resume key survives a worker crash and rotates after the resumed run is saved", () => {
  const first = prepareResume({ message: "hello" }, "run-1", () => "resume-1");
  const retry = prepareResume(first.payload, "run-1", () => "must-not-run");
  assert.equal(retry.key, "resume-1");

  const saved = finishResume(retry.payload);
  const secondRestart = prepareResume(saved, "run-2", () => "resume-2");
  assert.equal(secondRestart.key, "resume-2");
  assert.notEqual(secondRestart.key, retry.key);
});
