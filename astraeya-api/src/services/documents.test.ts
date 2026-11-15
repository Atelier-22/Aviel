import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDocument,
  formatDocuments,
  MAX_DOCUMENT_CHARS,
} from "./documents.service";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("extractDocument", () => {
  it("reads plain text, Markdown and CSV", async () => {
    for (const mediaType of ["text/plain", "text/markdown", "text/csv"]) {
      const doc = await extractDocument({
        name: "notes",
        mediaType,
        base64: b64("Photosynthesis turns light into energy."),
      });
      assert.equal(doc.text, "Photosynthesis turns light into energy.");
      assert.equal(doc.truncated, false);
    }
  });

  it("truncates very long documents and says so", async () => {
    const doc = await extractDocument({
      name: "thesis.txt",
      mediaType: "text/plain",
      base64: b64("a".repeat(MAX_DOCUMENT_CHARS + 10)),
    });
    assert.equal(doc.text?.length, MAX_DOCUMENT_CHARS);
    assert.equal(doc.truncated, true);
    assert.match(formatDocuments([doc]), /only the beginning is included/);
  });

  it("reports a format it cannot read instead of throwing", async () => {
    const doc = await extractDocument({
      name: "archive.zip",
      mediaType: "application/zip",
      base64: b64("not a document"),
    });
    assert.equal(doc.text, null);
    assert.match(doc.error ?? "", /can't be read yet/);
  });

  it("reports a damaged PDF instead of throwing", async () => {
    const doc = await extractDocument({
      name: "broken.pdf",
      mediaType: "application/pdf",
      base64: b64("this is not a pdf"),
    });
    assert.equal(doc.text, null);
    assert.match(doc.error ?? "", /could not be read/);
  });
});

describe("formatDocuments", () => {
  it("fences each document with its name", () => {
    const out = formatDocuments([
      { name: "a.txt", text: "alpha", truncated: false },
      { name: "b.pdf", text: null, truncated: false, error: "scanned" },
    ]);
    assert.match(out, /<document name="a.txt">\nalpha\n<\/document>/);
    assert.match(out, /<document name="b.pdf" readable="false">/);
  });
});
