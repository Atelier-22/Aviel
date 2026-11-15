import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FrameReader } from "./frames";
import { SentenceStream, splitSentences } from "./sentences";

function frame(header: object, audio: number[]): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + head.length + audio.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, head.length);
  out.set(head, 4);
  view.setUint32(4 + head.length, audio.length);
  out.set(audio, 8 + head.length);
  return out;
}

describe("FrameReader", () => {
  it("reassembles frames that arrive split at any byte", () => {
    const bytes = new Uint8Array([...frame({ index: 0, count: 2 }, [1, 2, 3]), ...frame({ index: 1, count: 2 }, [4, 5])]);
    for (let size = 1; size <= bytes.length; size++) {
      const r = new FrameReader();
      const got = [];
      for (let i = 0; i < bytes.length; i += size) got.push(...r.push(bytes.slice(i, i + size)));
      assert.deepEqual(got.map((f) => [f.header.index, [...f.audio]]), [[0, [1, 2, 3]], [1, [4, 5]]]);
    }
  });

  it("reads an error frame with no audio", () => {
    const r = new FrameReader();
    const [f] = r.push(frame({ index: 1, count: 3, error: "unavailable", remaining: ["b", "c"] }, []));
    assert.equal(f.header.error, "unavailable");
    assert.deepEqual(f.header.remaining, ["b", "c"]);
    assert.equal(f.audio.length, 0);
  });
});

describe("sentences (same file as the API's)", () => {
  it("splits and streams the same way", () => {
    assert.deepEqual(splitSentences("Hi there. **Bold** move!"), ["Hi there.", "Bold move!"]);
    const s = new SentenceStream();
    assert.deepEqual(s.push("One. Tw"), ["One."]);
    assert.deepEqual(s.end(), ["Tw"]);
  });
});
