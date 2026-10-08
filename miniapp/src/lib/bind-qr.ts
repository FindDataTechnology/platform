// Scanned payload → bind code (openspec: add-mp-scan-bind, D2).
//
// The web Settings page encodes `<origin>/settings/wechat-app?bindcode=<code>`
// into its QR, but a camera returns whatever is printed: a scheme-less host, a
// URL carrying other query parameters, the bare digits off a screenshot, or
// free text off the wrong poster entirely. One order — URL query, then bare
// digits, then a six-digit last path segment or fragment — decides what counts,
// and the login page and the guide page both call this, so there is exactly one
// answer to "is this a bind code". A payload with no code yields an explicit
// error string, never a silent no-op that leaves the user on an unchanged form.
//
// Deliberately free of Taro imports: the unit test (scripts/test-bind-qr.mjs)
// runs this under plain node.

const CODE = /^\d{6}$/;

export type BindPayload = { code: string } | { error: string };

const NO_CONTENT = "没有读到内容，请重新扫描";
const NO_CODE = "未识别到 6 位绑定码，请在电脑上打开平台「设置 → 微信小程序」后重新扫码";

export function parseBindPayload(raw: unknown): BindPayload {
  const text = String(raw ?? "").trim();
  if (!text) return { error: NO_CONTENT };
  // Bare digits come first on purpose: `new URL("https://482913")` parses
  // happily (a numeric hostname), so every all-digit payload would otherwise be
  // read as a URL and lose its code.
  if (CODE.test(text)) return { code: text };

  // Scans arrive with or without a scheme (`craw.example.com/settings/…`); give
  // the parser one so both shapes read the same.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: NO_CODE };
  }

  const query = (url.searchParams.get("bindcode") ?? "").trim();
  if (CODE.test(query)) return { code: query };

  const segment = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (CODE.test(segment)) return { code: segment };

  const fragment = url.hash.replace(/^#/, "").trim();
  if (CODE.test(fragment)) return { code: fragment };

  return { error: NO_CODE };
}