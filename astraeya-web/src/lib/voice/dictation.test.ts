import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_DICTATION_MS, shouldRestartDictation } from "./dictation";

describe("dictation restarts", () => {
  const start = 1_000_000;

  it("keeps listening after the browser stops at a pause", () => {
    assert.equal(shouldRestartDictation({ wanted: true, startedAt: start, now: start + 5_000 }), true);
  });

  it("keeps listening after a no-speech or network error", () => {
    for (const lastError of ["no-speech", "network", "aborted"]) {
      assert.equal(shouldRestartDictation({ wanted: true, startedAt: start, now: start + 1_000, lastError }), true);
    }
  });

  it("still listens at 19 minutes and stops at 20", () => {
    assert.equal(shouldRestartDictation({ wanted: true, startedAt: start, now: start + 19 * 60_000 }), true);
    assert.equal(shouldRestartDictation({ wanted: true, startedAt: start, now: start + MAX_DICTATION_MS }), false);
  });

  it("stops when the person tapped stop", () => {
    assert.equal(shouldRestartDictation({ wanted: false, startedAt: start, now: start + 1_000 }), false);
  });

  it("stops when the microphone is blocked", () => {
    assert.equal(shouldRestartDictation({ wanted: true, startedAt: start, now: start + 1_000, lastError: "not-allowed" }), false);
  });

  it("gives up after repeated instant failures", () => {
    assert.equal(shouldRestartDictation({ wanted: true, startedAt: start, now: start + 1_000, quickFailures: 5 }), false);
  });
});
