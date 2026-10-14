// QR generation for the bots management surface (redesign-bots-surface, D2).
//
// The server is the only place that knows both the resolved entry URL and the
// secrets behind it, so it also renders the SVG — the browser gets an image it
// can show directly and needs no QR library. Only entry URLs are ever encoded:
// http/https and a length cap keep a credential value from sneaking into a QR.

import QRCode from "qrcode";

// A QR tops out well below this; the cap bounds the SVG size, not the spec.
const MAX_URL_CHARS = 512;

// URL → SVG string. Throws on a non-http(s) or oversized value; callers turn
// that into the panel's failure state (never a 500 on the management surface).
export async function qrSvg(url) {
  const text = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(text)) throw new Error("QR target must be an http(s) URL");
  if (text.length > MAX_URL_CHARS) throw new Error("QR target exceeds 512 characters");
  return QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
