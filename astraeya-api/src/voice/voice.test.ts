import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SentenceStream, speakableText, splitSentences } from "./sentences";
import { DEFAULT_VOICE, FAST_VOICE, VOICES, findVoice, normalizeVoiceId, voiceLabel } from "./catalogue";

describe("splitSentences", () => {
  it("splits on sentence ends and keeps punctuation", () => {
    assert.deepEqual(splitSentences("Sure! Here is how. Does that help?"), ["Sure!", "Here is how.", "Does that help?"]);
  });

  it("does not split on abbreviations, initials, decimals or lower-case continuations", () => {
    assert.deepEqual(splitSentences("Dr. Okello paid 3.5 million, e.g. for fees. J. K. Rowling wrote it."), [
      "Dr. Okello paid 3.5 million, e.g. for fees.",
      "J. K. Rowling wrote it.",
    ]);
    assert.deepEqual(splitSentences("It costs approx. three dollars."), ["It costs approx. three dollars."]);
  });

  it("reads list items and headings as separate sentences, without their markers", () => {
    assert.deepEqual(splitSentences("## Steps\n1. Boil water\n2. Add **tea**\n- Serve"), ["Steps", "Boil water", "Add tea", "Serve"]);
  });

  it("leaves out code blocks, URLs and images, and keeps link words", () => {
    const text = "Run this:\n```python\nprint('hi')\n```\nSee [the docs](https://x.y/z) or https://example.com now. ![chart](c.png)";
    assert.deepEqual(splitSentences(text), ["Run this:", "See the docs or now."]);
  });

  it("splits very long sentences at a comma", () => {
    const long = Array.from({ length: 30 }, (_, i) => `item number ${i}`).join(", ") + ".";
    const parts = splitSentences(long);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 260));
    assert.equal(parts.join(" ").replace(/\s+/g, " "), long);
  });

  it("drops fragments with nothing to say", () => {
    assert.deepEqual(splitSentences("Done. ... —"), ["Done."]);
  });

  it("strips emphasis but keeps snake_case and maths", () => {
    assert.equal(speakableText("*really* __big__ my_var 2*3").trim(), "really big my_var 2*3");
  });
});

describe("SentenceStream", () => {
  it("hands out each sentence once, as soon as it is complete", () => {
    const s = new SentenceStream();
    const got: string[][] = [];
    for (const chunk of ["Hel", "lo there. How ", "are you? I am", " fine", "."]) got.push(s.push(chunk));
    got.push(s.end());
    // The first sentence is ready on the second chunk, long before the reply
    // ends; the last waits for end() because "fine." might continue.
    assert.deepEqual(got, [[], ["Hello there."], ["How are you?"], [], [], ["I am fine."]]);
  });

  it("waits for a code block to close before going on", () => {
    const s = new SentenceStream();
    assert.deepEqual(s.push("Here:\n```js\nconst a = 1. b = 2.\n"), []);
    assert.deepEqual(s.push("```\nThat is all. "), ["Here:", "That is all."]);
    assert.deepEqual(s.end(), []);
  });
});

describe("voice catalogue", () => {
  it("defaults to af_heart, which exists", () => {
    assert.equal(DEFAULT_VOICE, "af_heart");
    assert.ok(findVoice(DEFAULT_VOICE));
  });

  it("turns unknown ids, old browser voice names and null into af_heart", () => {
    for (const bad of [null, undefined, "", "Google UK English Female", "Microsoft Zira - English (United States)", "AF_HEART", 42]) {
      assert.equal(normalizeVoiceId(bad), "af_heart");
    }
    assert.equal(normalizeVoiceId("bm_george"), "bm_george");
  });

  it("labels voices as Name (Gender, Accent)", () => {
    assert.equal(voiceLabel(findVoice("af_heart")!), "Heart (Female, American)");
    assert.equal(voiceLabel(findVoice("bm_george")!), "George (Male, British)");
  });

  it("has fast voices of the right gender", () => {
    assert.equal(findVoice(FAST_VOICE.female)?.gender, "female");
    assert.equal(findVoice(FAST_VOICE.male)?.gender, "male");
  });

  it("matches the voice server's catalogue", () => {
    const file = path.join(__dirname, "..", "..", "..", "astraeya-voice", "voices.json");
    if (!existsSync(file)) return; // the API deployed on its own
    const source = JSON.parse(readFileSync(file, "utf8")) as { default: string; voices: { id: string; gender: string; engine: string }[] };
    assert.equal(source.default, DEFAULT_VOICE);
    assert.deepEqual(
      VOICES.map((v) => [v.id, v.gender, v.engine]),
      source.voices.map((v) => [v.id, v.gender, v.engine])
    );
  });
});

import { userSettingsSchema, settingsPatchSchema, defaultSettings } from "../settings/schema";
import {
  LIVE_FIRST_AUDIO_LIMIT_MS,
  liveVoiceFor,
  recordSpeed,
  resetSpeeds,
  resetVoiceAllowance,
  takeVoiceAllowance,
} from "./voice.service";

describe("the voice setting", () => {
  it("defaults to af_heart for a new account", () => {
    assert.equal(defaultSettings().voice.outputVoice, "af_heart");
  });

  it("reads old browser voice names and null as af_heart", () => {
    for (const old of [null, "Google UK English Female", "Samantha"]) {
      assert.equal(userSettingsSchema.parse({ voice: { outputVoice: old } }).voice.outputVoice, "af_heart");
    }
    assert.equal(userSettingsSchema.parse({ voice: { outputVoice: "bf_emma" } }).voice.outputVoice, "bf_emma");
  });

  it("corrects an unknown voice in a settings patch, and leaves other patches alone", () => {
    assert.equal(settingsPatchSchema.parse({ voice: { outputVoice: "Microsoft Zira" } }).voice?.outputVoice, "af_heart");
    assert.equal(settingsPatchSchema.parse({ voice: { rate: 1.2 } }).voice?.outputVoice, undefined);
  });
});

describe("migration 0015", () => {
  const sql = readFileSync(path.join(__dirname, "..", "..", "drizzle", "0015_voice_default_af_heart.sql"), "utf8");

  it("sets the column default to af_heart", () => {
    assert.match(sql, /ALTER COLUMN "voice_name" SET DEFAULT 'af_heart'/);
  });

  it("moves null and every non-Astraeya voice name to af_heart, keeping real voices", () => {
    assert.match(sql, /UPDATE "user_settings" SET "voice_name" = 'af_heart'\s+WHERE "voice_name" IS NULL OR "voice_name" NOT IN \(/);
    const inList = sql.match(/NOT IN \(([^)]*)\)/)?.[1] ?? "";
    const kept = [...inList.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(new Set(kept), new Set(VOICES.map((v) => v.id)));
  });
});

describe("live mode speed fallback", () => {
  it("keeps the chosen voice until its speed is known", () => {
    resetSpeeds();
    assert.deepEqual(liveVoiceFor("af_heart"), { voice: "af_heart", substituted: false });
  });

  it("switches to a fast voice of the same gender when first audio would take too long", () => {
    resetSpeeds();
    // Measured on one core: about 1.9 s of work per second of audio.
    recordSpeed("af_heart", 5300, 2.8);
    assert.deepEqual(liveVoiceFor("af_heart"), { voice: FAST_VOICE.female, substituted: true });
    assert.deepEqual(liveVoiceFor("am_michael"), { voice: FAST_VOICE.male, substituted: true });
    // Piper medium voices are measured separately and stay.
    recordSpeed("en_US-joe-medium", 400, 2.5);
    assert.deepEqual(liveVoiceFor("en_US-joe-medium"), { voice: "en_US-joe-medium", substituted: false });
  });

  it("keeps the chosen voice when it is fast enough", () => {
    resetSpeeds();
    recordSpeed("af_heart", 0.4 * LIVE_FIRST_AUDIO_LIMIT_MS, 2.5);
    assert.deepEqual(liveVoiceFor("af_heart"), { voice: "af_heart", substituted: false });
  });
});

describe("voice rate limit", () => {
  it("allows normal use and refuses a flood, per user", () => {
    resetVoiceAllowance();
    const now = 1_000_000;
    assert.equal(takeVoiceAllowance("a", 30_000, now), null);
    assert.match(takeVoiceAllowance("a", 20_000, now) ?? "", /Wait a moment/);
    assert.equal(takeVoiceAllowance("b", 20_000, now), null);
    // A new window starts after ten minutes.
    assert.equal(takeVoiceAllowance("a", 20_000, now + 11 * 60 * 1000), null);
  });
});

describe("the web app's copy of the sentence splitter", () => {
  it("is identical to this one", () => {
    const web = path.join(__dirname, "..", "..", "..", "astraeya-web", "src", "lib", "voice", "sentences.ts");
    if (!existsSync(web)) return; // the API checked out on its own
    assert.equal(readFileSync(web, "utf8"), readFileSync(path.join(__dirname, "sentences.ts"), "utf8"));
  });
});
