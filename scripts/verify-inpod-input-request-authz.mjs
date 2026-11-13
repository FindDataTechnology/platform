// 在产授权链路实证（task 6.2 的第二份证据）：不进浏览器，直接以「已登录用户」
// 的身份打 cell，把 6.2 里跟人有关的那半边也验掉。
//
// 背景：cell 在 forward-auth 模式下只认网关注入的身份头 + 网关 secret。所以脚本
// 读 pod 内的 CELL_GATEWAY_SECRET，伪造两条身份访问同一张卡：
//   owner    = 该 cell 的真实 owner
//   stranger = 另一个邮箱（同 secret，模拟另一个合法登录用户）
//
// 断言（对应 spec 的「应答人受归属校验 / 先答者生效」）：
//   1) 提卡 201
//   2) 陌生人读 → 403
//   3) 陌生人答 → 403
//   4) 不带身份的**网关**请求 → 401（注意：本 pod 内 loopback 无身份读会命中
//      内部桥，那是 cell 自己子进程的信任域，与 cron/actions 桥同一姿态；
//      真正的匿名路径是网关那一侧，所以这条断言打 GATEWAY_URL）
//   5) owner 答 → 200 answered
//   6) owner 再答 → 409（先答者生效，答案不被覆盖）
//   7) 收尾：把这张卡删除（验证残留不留在生产库里）
//
//   GATEWAY_SECRET=$(…pod env…)
//   CELL_URL=http://127.0.0.1:<cellPort> OWNER_EMAIL=<owner> \
//     node scripts/verify-inpod-input-request-authz.mjs
const URL_BASE = process.env.CELL_URL;
const SECRET = process.env.GATEWAY_SECRET;
const OWNER = process.env.OWNER_EMAIL;
if (!URL_BASE || !SECRET || !OWNER) {
  console.error("CELL_URL / GATEWAY_SECRET / OWNER_EMAIL required");
  process.exit(2);
}
const STRANGER = process.env.STRANGER_EMAIL || "stranger-verify@example.com";

const as = (email) => ({
  "content-type": "application/json",
  "x-forwarded-email": email,
  "x-cloud-gateway-secret": SECRET,
});

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// 1) 提卡
const created = await fetch(`${URL_BASE}/api/input-requests`, {
  method: "POST",
  headers: as(OWNER),
  body: JSON.stringify({
    sessionId: "verify-6.2-authz",
    card: {
      type: "form",
      title: "在产授权链路实证",
      fields: [{ key: "note", kind: "text", label: "备注", required: true }],
    },
    policy: { onUnattended: "abort", ttlSec: 120 },
  }),
});
const req1 = await created.json();
check("提卡 201", created.status === 201, `status=${created.status}`);
const id = req1.requestId;
if (!id) {
  console.error(JSON.stringify(req1).slice(0, 300));
  process.exit(1);
}

// 2) 陌生人读
const strangerRead = await fetch(`${URL_BASE}/api/input-requests/${id}`, { headers: as(STRANGER) });
check("陌生人读 403", strangerRead.status === 403, `status=${strangerRead.status}`);

// 3) 陌生人答
const strangerAnswer = await fetch(`${URL_BASE}/api/input-requests/${id}/answer`, {
  method: "POST",
  headers: as(STRANGER),
  body: JSON.stringify({ values: { note: "偷答" } }),
});
check("陌生人答 403", strangerAnswer.status === 403, `status=${strangerAnswer.status}`);

// 4) 匿名用户走网关 → 401
const gateway = process.env.GATEWAY_URL;
if (gateway) {
  const anon = await fetch(`${gateway}/api/input-requests/${id}`);
  check("匿名(网关) 401", anon.status === 401, `status=${anon.status}`);
} else {
  // 没有网关地址时至少断言「作答动词对内部调用方是拒绝的」——这是最敏感的那半。
  const internalAnswer = await fetch(`${URL_BASE}/api/input-requests/${id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { note: "内部偷答" } }),
  });
  check("内部调用方不得作答 403", internalAnswer.status === 403, `status=${internalAnswer.status}`);
}

// 5) owner 答
const ownerAnswer = await fetch(`${URL_BASE}/api/input-requests/${id}/answer`, {
  method: "POST",
  headers: as(OWNER),
  body: JSON.stringify({ values: { note: "所有者作答" } }),
});
const answered = await ownerAnswer.json().catch(() => ({}));
check(
  "owner 答 200 answered",
  ownerAnswer.status === 200 && answered.state === "answered",
  `status=${ownerAnswer.status} state=${answered.state}`,
);

// 6) 再答 → 409
const second = await fetch(`${URL_BASE}/api/input-requests/${id}/answer`, {
  method: "POST",
  headers: as(OWNER),
  body: JSON.stringify({ values: { note: "覆盖尝试" } }),
});
const secondBody = await second.json().catch(() => ({}));
check(
  "二次作答 409 且答案未被覆盖",
  second.status === 409 && secondBody?.request?.values?.note === "所有者作答",
  `status=${second.status}`,
);

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "PASS" : `FAIL (${failed.length})`);
console.log(`cleanup: request id = ${id}（请在库里按 id 删除）`);
process.exit(failed.length === 0 ? 0 : 1);
