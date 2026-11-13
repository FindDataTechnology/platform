// ── msgtype 解析插件 ────────────────────────────────────────────────────────
//
// 官方 msgtype 是字符串，且会加新类型。这里的原则只有一条：
// **没见过的类型不许导致丢消息** —— 落 `unknown`，正文留空，但 `raw` 原样保存，
// 事后可以补解析（补解析比重拉容易，因为官方只保留 5 天）。
//
// 第二个原则：能让检索命中的字段写进 `text`。链接的标题、文件的文件名、小程序名，
// 都是"人会说出口"的东西，搜不到就等于没有。

/** 取第一个非空值，容忍官方字段名大小写/下划线差异。 */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

const EXTRACTORS = {
  text: (p) => ({ text: String(pick(p.text, "content") ?? p.content ?? "") }),

  image: (p) => ({
    text: "",
    media: {
      sdkFileId: pick(p.image, "sdkfileid", "sdk_file_id"),
      mediaType: "image",
      bytes: Number(pick(p.image, "filesize", "file_size") ?? 0),
    },
  }),

  voice: (p) => ({
    text: "",
    media: {
      sdkFileId: pick(p.voice, "sdkfileid", "sdk_file_id"),
      mediaType: "voice",
      bytes: Number(pick(p.voice, "filesize") ?? 0),
      durationMs: Number(pick(p.voice, "play_length", "playlength") ?? 0) * 1000,
    },
  }),

  video: (p) => ({
    text: "",
    media: {
      sdkFileId: pick(p.video, "sdkfileid", "sdk_file_id"),
      mediaType: "video",
      bytes: Number(pick(p.video, "filesize") ?? 0),
      durationMs: Number(pick(p.video, "play_length", "playlength") ?? 0) * 1000,
    },
  }),

  file: (p) => {
    const name = String(pick(p.file, "filename", "file_name") ?? "");
    return {
      text: name, // 文件名要能被搜到
      media: {
        sdkFileId: pick(p.file, "sdkfileid", "sdk_file_id"),
        mediaType: "file",
        bytes: Number(pick(p.file, "filesize", "file_size") ?? 0),
        name,
      },
    };
  },

  link: (p) => {
    const title = String(pick(p.link, "title") ?? "");
    const desc = String(pick(p.link, "description", "desc") ?? "");
    return { text: [title, desc].filter(Boolean).join(" — ") };
  },

  weapp: (p) => {
    const title = String(pick(p.weapp, "title", "displayname") ?? "");
    const desc = String(pick(p.weapp, "description", "desc") ?? "");
    return { text: [title, desc].filter(Boolean).join(" — ") };
  },

  emotion: (p) => ({ text: String(pick(p.emotion, "title") ?? "[表情]") }),

  location: (p) => {
    const title = String(pick(p.location, "title") ?? "");
    const address = String(pick(p.location, "address") ?? "");
    return { text: [title, address].filter(Boolean).join(" — ") || "[位置]" };
  },

  card: (p) => ({ text: String(pick(p.card, "corpname", "userid") ?? "[名片]") }),

  revoke: (p) => ({ text: "[撤回]", extra: { preMsgId: pick(p.revoke, "pre_msgid") } }),

  agree: () => ({ text: "[同意存档确认]" }),

  chatrecord: (p) => {
    // 合并转发：把每条子消息的文本拼起来，否则整段聊天记录搜不到
    const items = pick(p.chatrecord, "item") ?? [];
    const parts = [];
    for (const it of Array.isArray(items) ? items : []) {
      const t = it?.type;
      if (t === "text" && it?.text?.content) parts.push(String(it.text.content));
      else if (t === "link" && it?.link?.title) parts.push(String(it.link.title));
    }
    return { text: parts.join(" / ") };
  },

  mixed: (p) => {
    const items = pick(p.mixed, "item") ?? [];
    const parts = [];
    for (const it of Array.isArray(items) ? items : []) {
      if (it?.type === "text" && it?.content) parts.push(String(it.content));
    }
    return { text: parts.join(" / ") };
  },

  meeting: (p) => ({ text: String(pick(p.meeting, "topic") ?? "[会议]") }),
  docmsg: (p) => ({ text: String(pick(p.docmsg, "title") ?? "[文档]") }),
  markdown: (p) => ({ text: String(pick(p.markdown, "content") ?? "") }),
  news: (p) => ({ text: String(pick(p.news, "title") ?? "[图文]") }),
  calendar: (p) => ({ text: String(pick(p.calendar, "title") ?? "[日程]") }),
  redpacket: () => ({ text: "[红包]" }),
  external_redpacket: () => ({ text: "[红包]" }),
  qydiskfile: (p) => ({ text: String(pick(p.qydiskfile, "filename") ?? "[微盘文件]") }),
  sphfeed: (p) => ({ text: String(pick(p.sphfeed, "nickname") ?? "[视频号]") }),
};

export const SUPPORTED_TYPES = Object.freeze(Object.keys(EXTRACTORS));

/**
 * 解析一条已解密的官方报文。
 *
 * 返回 `{ msgType, text, media, extra, raw, known }`。
 * `known=false` 只表示"没有专门的解析器"，不表示"这条要丢"。
 */
export function parseMessage(payload = {}) {
  const msgType = String(payload.msgtype ?? payload.msg_type ?? "unknown");
  const extractor = EXTRACTORS[msgType];
  if (!extractor) {
    // 未知类型：不丢，正文留空，raw 留全。
    return { msgType, text: "", media: null, extra: null, raw: payload, known: false };
  }
  let out;
  try {
    out = extractor(payload) || {};
  } catch {
    // 解析器自己炸了也不能丢消息：降级成 unknown 但保留 raw
    return { msgType, text: "", media: null, extra: null, raw: payload, known: false };
  }
  return {
    msgType,
    text: typeof out.text === "string" ? out.text : "",
    media: out.media ?? null,
    extra: out.extra ?? null,
    raw: payload,
    known: true,
  };
}

/** 批量解析时的类型分布——巡检面用，能看出"新增了哪种类型我们还没解析"。 */
export function typeHistogram(payloads = []) {
  const hist = {};
  for (const p of payloads) {
    const t = String(p?.msgtype ?? "unknown");
    hist[t] = (hist[t] || 0) + 1;
  }
  return hist;
}
