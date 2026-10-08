// Unit tests for the web QR helper (openspec: add-mp-scan-bind, task 1.2). The
// repo has no browser-side unit runner, so the helper is tested where it can
// be: under plain node, with the module matrix re-derived from the SVG path
// the renderer emitted. That is the property the settings page depends on —
// the code shown really is the encoding of the bind URL it was given, not of
// some other string, level, or size. The rendered DOM SVG is decode-verified
// in e2e/settings-wechat-app.spec.js, which is the browser half.
//
// Runs under `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import { qrSvg } from "../web/src/lib/qr.ts";
import { create } from "qrcode/lib/core/qrcode.js";

const URL_UNDER_TEST = "https://craw.finddatatech.cloud/settings/wechat-app?bindcode=482913";

// The dark modules are emitted as one path of `M x y` / `m dx 0` / `h run`
// commands (renderer/svg-tag.js qrToPath). Replaying those run lengths against
// the matrix the encoder produced is an independent read of the same picture:
// it never consults the renderer's own options.
function matrixFromSvg(svg, size, margin) {
  const dark = /<path stroke="[^"]*" d="([^"]*)"/.exec(svg);
  assert.ok(dark, "the SVG carries a dark-module path");
  const cells = new Array(size * size).fill(0);
  const re = /([Mmh])\s*(-?[\d.]+)(?:\s+(-?[\d.]+))?/g;
  let x = 0;
  let y = 0;
  let cmd = re.exec(dark[1]);
  while (cmd) {
    const [, op, a, b] = cmd;
    if (op === "M") {
      x = Number(a);
      y = Number(b);
    } else if (op === "m") {
      x += Number(a);
      y += Number(b ?? 0);
    } else {
      const row = Math.round(y - 0.5 - margin);
      const col = Math.round(x - margin);
      assert.ok(row >= 0 && row < size, `module row ${row} is inside the grid`);
      for (let i = 0; i < Number(a); i++) cells[row * size + col + i] = 1;
      x += Number(a);
    }
    cmd = re.exec(dark[1]);
  }
  return cells;
}

test("encodes the given text at the default size", () => {
  const svg = qrSvg(URL_UNDER_TEST);
  const expected = create(URL_UNDER_TEST, { errorCorrectionLevel: "M" });
  const side = expected.modules.size + 4;

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  assert.match(svg, /width="176" height="176"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
  assert.deepEqual(
    matrixFromSvg(svg, expected.modules.size, 2),
    Array.from(expected.modules.data),
    "the rendered modules are the encoding of the URL that was passed in",
  );
});

test("a different URL produces a different code", () => {
  const a = qrSvg(URL_UNDER_TEST);
  const b = qrSvg("https://craw.finddatatech.cloud/settings/wechat-app?bindcode=482914");
  assert.notEqual(a, b, "the code tracks the code, not a constant");
});

test("size scales the drawing without changing the module grid", () => {
  const small = qrSvg(URL_UNDER_TEST, { size: 132 });
  const large = qrSvg(URL_UNDER_TEST, { size: 264 });
  assert.match(small, /width="132" height="132"/);
  assert.match(large, /width="264" height="264"/);
  const viewBox = (svg) => /viewBox="([^"]*)"/.exec(svg)[1];
  assert.equal(viewBox(small), viewBox(large), "only the rendered edge length changes");
});

test("the level prop reaches the encoder", () => {
  const low = create(URL_UNDER_TEST, { errorCorrectionLevel: "L" });
  const high = create(URL_UNDER_TEST, { errorCorrectionLevel: "H" });
  assert.ok(high.modules.size > low.modules.size, "H reserves more modules than L for this payload");

  const highSvg = qrSvg(URL_UNDER_TEST, { level: "H" });
  const side = high.modules.size + 4;
  assert.match(highSvg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
  assert.deepEqual(matrixFromSvg(highSvg, high.modules.size, 2), Array.from(high.modules.data));
});