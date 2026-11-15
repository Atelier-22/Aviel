import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  contentDisposition,
  safeFilename,
  signDownload,
  verifyDownload,
} from "./files.service";
import { env } from "../env";

describe("download links", () => {
  it("round-trips the file and its owner", () => {
    const { token, expiresAt } = signDownload("file_1", "user_1");
    assert.deepEqual(verifyDownload(token), { fileId: "file_1", userId: "user_1" });
    assert.ok(expiresAt.getTime() > Date.now());
  });

  it("rejects a tampered, expired or login token", () => {
    const { token } = signDownload("file_1", "user_1");
    assert.equal(verifyDownload(token.slice(0, -2) + "xx"), null);

    const expired = jwt.sign({ f: "file_1", u: "user_1" }, env.JWT_SECRET, {
      audience: "astraeya-file-download",
      expiresIn: -10,
    });
    assert.equal(verifyDownload(expired), null);

    // A login token is signed with the same secret but is not a download link.
    const login = jwt.sign({ sub: "user_1" }, env.JWT_SECRET, { expiresIn: 60 });
    assert.equal(verifyDownload(login), null);
  });
});

describe("safeFilename", () => {
  it("strips paths and characters a phone or header can't take", () => {
    assert.equal(safeFilename("/mnt/outputs/Cover Letter.pdf"), "Cover Letter.pdf");
    assert.equal(safeFilename('..\\a"b<c>.docx'), "abc.docx");
    assert.equal(safeFilename(".."), "file");
  });

  it("shortens long names and keeps the extension", () => {
    const name = safeFilename("x".repeat(300) + ".pptx");
    assert.equal(name.length, 120);
    assert.ok(name.endsWith(".pptx"));
  });
});

describe("contentDisposition", () => {
  it("keeps non-English names with an ASCII fallback", () => {
    const header = contentDisposition("Ripoti ya Kampala – 2026.pdf", false);
    assert.match(header, /^attachment; filename="Ripoti ya Kampala _ 2026.pdf"/);
    assert.match(header, /filename\*=UTF-8''Ripoti%20ya%20Kampala%20%E2%80%93%202026\.pdf$/);
  });
});
