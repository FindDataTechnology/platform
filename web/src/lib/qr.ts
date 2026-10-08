// QR rendering for the web binding surfaces (openspec: add-mp-scan-bind, D1).
//
// The mini-program bind code is presented twice — as digits and as a QR
// encoding `<origin>/settings/wechat-app?bindcode=<code>` — so one secret
// serves scan and type alike. Rendering stays client-side (no image upload, no
// new server route) and SVG-only: `qrcode`'s svg-tag renderer emits a plain
// string, which drops into the React tree with no canvas element and no
// mounted DOM to measure.
//
// The two deep entry points (core encoder + svg-tag renderer) are used rather
// than the package's browser bundle for one reason: that bundle wraps
// `toString` in a promise and pulls in the canvas renderer, so the QR could not
// be part of the same paint as the digits it belongs to. Both paths are inside
// the package's own browser build, and neither reaches `fs`, `pngjs`, or a
// canvas implementation. Types live in src/types/qrcode.d.ts.
//
// Pure by design: `scripts/test-qr-svg.mjs` exercises it under plain node.

import { create } from "qrcode/lib/core/qrcode.js";
import { render } from "qrcode/lib/renderer/svg-tag.js";

export type QrLevel = "L" | "M" | "Q" | "H";

export interface QrSvgOptions {
  /** Rendered edge length in px. The module grid scales to it. */
  size?: number;
  /** Error-correction level. "M" is the standard margin for a screen scan. */
  level?: QrLevel;
  /** Quiet zone in modules. */
  margin?: number;
}

export function qrSvg(text: string, { size = 176, level = "M", margin = 2 }: QrSvgOptions = {}): string {
  const data = create(text, { errorCorrectionLevel: level });
  return render(data, { width: size, margin });
}