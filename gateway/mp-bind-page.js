// ── Human-facing bind-code page (shared by both deployment shapes) ───────────
//
// `GET /api/mp/bindcode` answers two audiences: programmatic callers get JSON,
// browsers get this page. The page used to be copy-pasted verbatim into the
// gateway's route table and the single-process route module, which meant any
// copy change (validity wording, the refresh link) had to land in two places
// and drift was only observable on the deployment shape you were not looking
// at. One renderer, two hosts (openspec: miniprogram-auth — the shared-shape
// requirement).
//
// Presentation only: no state, no auth. The caller has already resolved the
// account and minted a code.

/**
 * @param {{ code: string, email: string }} input
 * @returns {string} a complete HTML document
 */
export function renderBindCodePage({ code, email }) {
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>绑定小程序</title>
<body style="font-family:system-ui;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f3f4f6">
  <div style="text-align:center;background:#fff;padding:48px 64px;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
    <div style="color:#6b7280;font-size:14px">微信小程序 · 登录绑定码（${email}）</div>
    <div style="font-size:56px;letter-spacing:12px;font-weight:700;color:#111827;margin:24px 0">${code}</div>
    <div style="color:#9ca3af;font-size:13px">5 分钟内有效，一次性使用。在小程序登录页输入此码完成绑定。</div>
    <div style="margin-top:20px"><a href="/api/mp/bindcode" style="color:#2563eb;font-size:14px">刷新新码</a></div>
  </div>
</body>`;
}
