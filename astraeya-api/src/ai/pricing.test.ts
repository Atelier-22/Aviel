import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCost } from "./pricing";

describe("estimated cost per model", () => {
  const million = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("prices Athena 2.5 above Metis 3.0 above Lotus", () => {
    assert.equal(estimateCost("advanced", million), 24);
    assert.equal(estimateCost("standard", million), 12);
    assert.equal(estimateCost("quick", million), 0.6);
  });

  it("counts cache reads cheaply and unknown models as free", () => {
    assert.equal(estimateCost("standard", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }), 0.1);
    assert.equal(estimateCost("local-llama", million), 0);
    assert.equal(estimateCost(null, million), 0);
  });
});
