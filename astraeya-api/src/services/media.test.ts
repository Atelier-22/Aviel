import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSvg, slugFor } from "./media.service";

describe("sanitizeSvg", () => {
  it("removes scripts, event handlers, foreign content and javascript links", () => {
    const dirty =
      '<svg onload="alert(1)"><script>alert(2)</script><foreignObject><iframe/></foreignObject>' +
      '<a href="javascript:alert(3)"><rect onclick=\'x()\' width="1"/></a></svg>';
    const clean = sanitizeSvg(dirty);
    assert.doesNotMatch(clean, /script|onload|onclick|foreignObject|javascript:/i);
    assert.match(clean, /<rect/);
  });

  it("leaves an ordinary logo untouched", () => {
    const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#123456"/></svg>';
    assert.equal(sanitizeSvg(svg), svg);
  });
});

describe("slugFor", () => {
  it("makes a short, safe filename from a prompt", () => {
    assert.equal(slugFor("Make a 5-second video of a sunrise over Kampala!", "video"), "5-second-video-sunrise-over-kampala");
    assert.equal(slugFor("!!!", "image"), "image");
  });
});
