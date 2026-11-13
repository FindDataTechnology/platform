// ── 真实响应形状核对 ────────────────────────────────────────────────────────
//
// 这个模块存在的理由只有一句：**我的夹具是按官方文档抄的，不是抄腾讯的**。
// 桩库全绿只能证明"客户端与我抄的形状一致"，不能证明"与线上一致"。
// 所以在拿到真凭据的第一天，必须做一次真实响应对位，否则后面所有"绿"都悬在文档上。
//
// 设计上把它拆成纯函数：`verifyShape({token, accounts, sync})` —— 不做网络、不打日志，
// 因此可以用"故意漂移的样本"证明它真的会红。一个识别不出漂移的核对器比没有更糟。
//
// 三类漂移最值得抓：
//   1. `send_time` 变成毫秒（13 位）—— 会把消息时间推到 5 万年以后
//   2. `origin` 变成字符串 —— 严格比较会判成 unknown，商机全被过滤掉
//   3. 字段改名（例如 `msg_list` → `messages`）—— 客户端会静默拿到空数组

const KNOWN_MSGTYPES = new Set([
  "text",
  "image",
  "voice",
  "video",
  "file",
  "location",
  "link",
  "business_card",
  "miniprogram",
  "msgmenu",
  "event",
]);

const KNOWN_ORIGINS = [3, 4, 5];

function check(name, ok, { expected, actual, note } = {}) {
  return { name, ok: Boolean(ok), expected, actual, ...(note ? { note } : {}) };
}

/** 10 位秒级时间戳落在 2001–2286 之间；13 位是毫秒的典型症状。 */
export function looksLikeSeconds(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 1e9 && n < 1e11;
}

export function verifyShape({ token = null, accounts = null, sync = null, sampleSize = 5 } = {}) {
  const checks = [];

  if (token) {
    checks.push(check("gettoken.errcode", Number(token.errcode) === 0, { actual: token.errcode }));
    checks.push(
      check("gettoken.access_token", typeof token.access_token === "string" && token.access_token.length > 0, {
        expected: "非空字符串",
        actual: typeof token.access_token,
      }),
    );
    checks.push(
      check("gettoken.expires_in", Number.isFinite(Number(token.expires_in)) && Number(token.expires_in) > 0, {
        expected: "正数（秒）",
        actual: token.expires_in,
      }),
    );
  }

  if (accounts) {
    const list = accounts.account_list;
    checks.push(
      check("account_list 是数组", Array.isArray(list), {
        expected: "array",
        actual: Array.isArray(list) ? `array(${list.length})` : typeof list,
      }),
    );
    if (Array.isArray(list) && list.length) {
      const a = list[0];
      checks.push(
        check("account_list[].open_kfid", typeof a.open_kfid === "string" && a.open_kfid.length > 0, {
          actual: typeof a.open_kfid,
        }),
      );
      checks.push(check("account_list[].name", "name" in a, { actual: Object.keys(a).join(",") }));
    } else {
      checks.push(
        check("account_list 非空", false, {
          expected: "至少一个客服账号",
          actual: `${list?.length ?? 0} 个`,
          note: "账号列表为空：后台可能未创建客服账号，或应用未被选为「可调用接口的应用」",
        }),
      );
    }
  }

  if (sync) {
    checks.push(
      check("sync_msg.next_cursor 是字符串", typeof sync.next_cursor === "string", {
        expected: "string",
        actual: typeof sync.next_cursor,
      }),
    );
    checks.push(
      check("sync_msg.has_more 是 0/1", [0, 1].includes(Number(sync.has_more)), {
        expected: "0 或 1",
        actual: sync.has_more,
      }),
    );
    const list = sync.msg_list;
    checks.push(
      check("sync_msg.msg_list 是数组", Array.isArray(list), {
        expected: "array",
        actual: Array.isArray(list) ? `array(${list.length})` : `${typeof list}（字段可能改名）`,
      }),
    );

    const sample = Array.isArray(list) ? list.slice(0, sampleSize) : [];
    if (!sample.length) {
      checks.push(
        check("窗口内有消息可核对", false, {
          expected: "至少一条",
          actual: "0 条",
          note: "3 天窗口内没有消息：先从微信侧给客服号发一条，再重跑本检查",
        }),
      );
    }
    for (const [i, m] of sample.entries()) {
      const tag = `msg[${i}]`;
      checks.push(check(`${tag}.msgid`, typeof m.msgid === "string" && m.msgid.length > 0, { actual: typeof m.msgid }));
      checks.push(check(`${tag}.open_kfid`, typeof m.open_kfid === "string" && m.open_kfid.length > 0, { actual: typeof m.open_kfid }));
      checks.push(
        check(`${tag}.external_userid`, typeof m.external_userid === "string", { actual: typeof m.external_userid }),
      );
      checks.push(
        check(`${tag}.send_time 是秒级`, looksLikeSeconds(m.send_time), {
          expected: "10 位秒级整数",
          actual: m.send_time,
          note: looksLikeSeconds(m.send_time) ? undefined : "若是 13 位则是毫秒：入库时间会被推到未来",
        }),
      );
      const originIsNumberInSet =
        typeof m.origin === "number" && KNOWN_ORIGINS.includes(m.origin);
      checks.push(
        check(`${tag}.origin 是数字 3/4/5`, originIsNumberInSet, {
          expected: "number ∈ {3,4,5}",
          actual: `${typeof m.origin}:${m.origin}`,
          note: originIsNumberInSet
            ? undefined
            : typeof m.origin !== "number"
              ? "字符串 3/5 会被判成 unknown，客户发言会被过滤掉"
              : `取值 ${m.origin} 不在 3/4/5 内：来源无法判定，会被当 unknown`,
        }),
      );
      checks.push(
        check(`${tag}.msgtype 在已知集合内`, KNOWN_MSGTYPES.has(String(m.msgtype)), {
          expected: [...KNOWN_MSGTYPES].join("|"),
          actual: m.msgtype,
          note: KNOWN_MSGTYPES.has(String(m.msgtype)) ? undefined : "未知类型会入库但正文是占位，需要补解析器",
        }),
      );
      if (String(m.msgtype) === "text") {
        const content = m.text?.content;
        checks.push(
          check(`${tag}.text.content 是字符串`, typeof content === "string", {
            actual: typeof content,
          }),
        );
      }
      if (String(m.msgtype) === "image") {
        checks.push(
          check(`${tag}.image.media_id 存在`, typeof m.image?.media_id === "string", {
            actual: typeof m.image?.media_id,
          }),
        );
      }
      if (String(m.msgtype) === "event") {
        checks.push(
          check(`${tag}.event.event_type 存在`, typeof m.event?.event_type === "string", {
            actual: typeof m.event?.event_type,
          }),
        );
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
    drift: failed.map((c) => `${c.name}: 期望 ${c.expected ?? "—"}，实际 ${c.actual ?? "—"}`),
  };
}

/** 一行结论。 */
export function shapeLine(result) {
  if (result.ok) return `形状核对通过：${result.total} 项全部相符`;
  return `形状核对未通过：${result.failed}/${result.total} 项不符`;
}
