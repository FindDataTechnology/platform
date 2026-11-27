// ── 微信客服：附件文本化 ────────────────────────────────────────────────────
//
// 为什么需要这一层：微信客服的 `file` 消息**只有 `media_id`，没有文件名**
// （`parse.js` 里写着"不要假装有"），所以落盘时扩展名只能是 `.bin`；而
// `filterForAgentInput` 只按 origin 过滤，file 行的 `text` 是空串——附件被下载了、
// 状态 `done`、字节数也对，但**内容谁都读不到**。
//
// 四条纪律：
//
//   1. **不依赖文件名判类型**。名字不可信（kf 根本不给），后缀也不可信。
//      按内容判：魔数 → ZIP/OLE 容器里的条目名 → 扩展名只作提示。
//   2. **从不抛异常**。抽取是"锦上添花"的一步，它失败绝不能连累消息入库、
//      连累同一轮的其他附件，更不能把进程带崩。
//   3. **依赖缺失是正常形态**。纯 sidecar 部署只拷 Node 标准库文件，
//      办公文档解析器不在里面。所以解析器一律动态 import，缺了就报
//      `no_extractor` —— 这是可观测的状态，不是被吞掉的异常。
//   4. **不经过 readers.js**。那个模块在这一版 officeparser 上是坏的：v7 的回调
//      改传 `result` 对象（文本要 `.toText()`），而它仍按字符串 `text.trim()`，
//      于是抛 `text.trim is not a function`；更糟的是 `parseOffice` 在回调报错后
//      **还会再抛一次**，那条被丢弃的 promise 变成 unhandledRejection。
//      这里直接调 officeparser 的 v7 接口，自己拿到 promise，错误就进得来。

/** 输入上限：与官方普通文件上限一致（见 api.js 的 UPLOAD_MAX_BYTES 注释）。 */
export const EXTRACT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 输出上限。一张几万行的表摊成文本能到几十万字符，塞进库和上下文都是灾难
 * （一次 agent 输入就被吃光）。截断但**如实记账**：`chars` 记截断前的真实值。
 */
export const EXTRACT_MAX_CHARS = 20000;

/** 单次抽取的墙钟预算。超过就判失败，绝不把拉取轮次挂在这里。 */
export const EXTRACT_TIMEOUT_MS = 15000;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * 在字节里找 ASCII 串（ZIP 的本地文件头与中央目录都把条目名按明文存）。
 * 不解压、不引依赖——只要判断"容器里有没有这个条目名"。
 */
function containsAscii(buffer, needle) {
  return buffer.indexOf(Buffer.from(needle, "latin1")) !== -1;
}

/** OLE/CFB 的目录条目名是 UTF-16LE，所以拿同样的编码去找。 */
function containsUtf16le(buffer, needle) {
  return buffer.indexOf(Buffer.from(needle, "utf16le")) !== -1;
}

/**
 * 按内容判定附件类型。
 *
 * 返回的 kind 是**能直接决定用哪个解析器**的粒度：
 * `xlsx/docx/pptx/doc/xls/pdf/csv/txt/zip/unknown`。
 * 判不出就返回 `unknown` 并给原因——绝不猜一个类型去解析（猜错的表现是
 * "解析器抛了一个看不懂的错"，比"未识别"难查得多）。
 *
 * @param {{buffer?: Buffer, fileNameHint?: string}} input
 * @returns {{kind: string, basis: string, reason?: string}}
 */
export function sniffAttachmentKind({ buffer, fileNameHint = "" } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  if (buf.length < 4) {
    return { kind: "unknown", basis: "magic", reason: `文件只有 ${buf.length} 字节，不足以判定类型` };
  }

  if (startsWith(buf, PDF_MAGIC)) return { kind: "pdf", basis: "magic" };

  if (startsWith(buf, ZIP_MAGIC)) {
    // xlsx/docx/pptx 都是 ZIP 容器，靠条目名区分。
    if (containsAscii(buf, "xl/workbook.xml")) return { kind: "xlsx", basis: "zip-entry" };
    if (containsAscii(buf, "word/document.xml")) return { kind: "docx", basis: "zip-entry" };
    if (containsAscii(buf, "ppt/presentation.xml")) return { kind: "pptx", basis: "zip-entry" };
    return { kind: "zip", basis: "zip-entry", reason: "ZIP 容器里没有办公文档的主条目" };
  }

  if (startsWith(buf, CFB_MAGIC)) {
    // 老格式：OLE 复合文档。目录条目名是 UTF-16LE，据此分 doc / xls。
    if (containsUtf16le(buf, "WordDocument")) return { kind: "doc", basis: "cfb-entry" };
    if (containsUtf16le(buf, "Workbook")) return { kind: "xls", basis: "cfb-entry" };
    if (containsUtf16le(buf, "Book")) return { kind: "xls", basis: "cfb-entry" };
    return { kind: "cfb", basis: "cfb-entry", reason: "OLE 复合文档里没有 Word/Excel 的流名" };
  }

  // 文本没有魔数：前 8KB 不含 NUL 才当文本。含 NUL 的二进制（图片/音视频/可执行）
  // 一律落到 unknown，不去尝试解析。
  const head = buf.subarray(0, 8192);
  if (!head.includes(0x00)) {
    const hint = String(fileNameHint || "").toLowerCase();
    return { kind: hint.endsWith(".csv") ? "csv" : "txt", basis: "no-nul" };
  }

  return { kind: "unknown", basis: "magic", reason: "既不是 PDF/OLE/ZIP，也不像文本（前 8KB 含二进制字节）" };
}

/** 哪些 kind 交给 officeparser。 */
const OFFICE_KINDS = new Set(["xlsx", "docx", "pptx", "doc", "xls", "cfb"]);

class ExtractTimeout extends Error {}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    // 刻意**不** unref：这个定时器是"对方永不返回"时唯一的出路。
    // 它在 finally 里被清掉，所以不会拖住进程退出。
    timer = setTimeout(() => reject(new ExtractTimeout(`${label} 超过 ${ms}ms`)), ms);
  });
  // 被放弃的那条分支仍会 settle：不接 catch 就是 unhandledRejection，能带崩进程。
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * officeparser v7：`parseOffice(buffer)` 返回对象，文本在 `.toText()` 上。
 * 同时兼容 v6 那种"直接返回字符串"的形态——升级依赖时不必改这里。
 */
async function defaultExtractOffice(buffer) {
  const mod = await import("officeparser");
  const parser = mod?.default ?? mod;
  if (typeof parser?.parseOffice !== "function") throw new Error("officeparser 缺少 parseOffice");
  const result = await parser.parseOffice(buffer);
  if (typeof result?.toText === "function") return String(result.toText());
  if (typeof result === "string") return result;
  throw new Error("officeparser 没有给出文本（既无 toText() 也不是字符串）");
}

async function defaultExtractPdf(buffer) {
  const mod = await import("pdf-parse");
  if (typeof mod?.PDFParse !== "function") throw new Error("pdf-parse 缺少 PDFParse");
  const parser = new mod.PDFParse({ data: new Uint8Array(buffer) });
  try {
    const out = await parser.getText();
    return String(out?.text || "");
  } finally {
    // v2 的解析器会起 worker；不 destroy 会泄漏。
    parser.destroy?.();
  }
}

/**
 * 把附件缓冲抽成纯文本。
 *
 * 返回形状（**永不抛**）：
 *   `{ok:true, kind, text, chars, truncated}`
 *   `{ok:false, kind, code, reason}`，code ∈
 *   `too_large | unknown_kind | no_extractor | empty | timeout | error`
 *
 * @param {object} input
 * @param {Buffer} input.buffer
 * @param {string} [input.kind]        先算好可省一次判定；不传则内部 sniff
 * @param {string} [input.fileNameHint]
 * @param {number} [input.maxBytes]
 * @param {number} [input.maxChars]
 * @param {number} [input.timeoutMs]
 * @param {{extractOffice?: Function, extractPdf?: Function}} [input.deps] 仅测试注入
 */
export async function extractAttachment({
  buffer,
  kind = "",
  fileNameHint = "",
  maxBytes = EXTRACT_MAX_BYTES,
  maxChars = EXTRACT_MAX_CHARS,
  timeoutMs = EXTRACT_TIMEOUT_MS,
  deps = {},
} = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  let resolved = kind;
  if (!resolved) {
    const sniffed = sniffAttachmentKind({ buffer: buf, fileNameHint });
    resolved = sniffed.kind;
    if (resolved === "unknown") {
      return { ok: false, kind: "unknown", code: "unknown_kind", reason: sniffed.reason || "类型未识别" };
    }
  }

  // 体积闸在最前：20MB 的 xlsx 读进解析器既慢又可能直接 OOM。
  if (buf.length > Number(maxBytes)) {
    return {
      ok: false,
      kind: resolved,
      code: "too_large",
      reason: `文件 ${buf.length} 字节，超过抽取输入上限 ${maxBytes}`,
    };
  }
  if (!buf.length) {
    return { ok: false, kind: resolved, code: "empty", reason: "空文件" };
  }

  const finish = (raw) => {
    // NUL 是解析器的常态噪音（尤其是 docx 的嵌入对象），去掉再判空。
    const text = String(raw ?? "")
      .split("\u0000")
      .join("")
      .trim();
    if (!text) return { ok: false, kind: resolved, code: "empty", reason: "没有抽到文本（可能是扫描件或空表）" };
    const chars = text.length;
    const truncated = chars > Number(maxChars);
    return {
      ok: true,
      kind: resolved,
      text: truncated ? text.slice(0, Number(maxChars)) : text,
      chars,
      truncated,
    };
  };

  // 文本与 CSV 不需要任何解析器：直接按 UTF-8 解。
  // 这是唯一不存在"无解析器"状态的类型，也是 sidecar 形态下仍能用的那一档。
  if (resolved === "txt" || resolved === "csv") {
    return finish(buf.toString("utf8").replace(/^\uFEFF/, ""));
  }

  if (resolved === "pdf") {
    try {
      const extractPdf = deps.extractPdf || defaultExtractPdf;
      return finish(await withTimeout(extractPdf(buf), timeoutMs, "解析 pdf"));
    } catch (err) {
      return toFailure(resolved, err);
    }
  }

  if (OFFICE_KINDS.has(resolved)) {
    try {
      const extractOffice = deps.extractOffice || defaultExtractOffice;
      return finish(await withTimeout(extractOffice(buf), timeoutMs, "解析办公文档"));
    } catch (err) {
      return toFailure(resolved, err);
    }
  }

  // zip / 其他：明确说"这个类型不抽"，而不是硬塞给解析器。
  return { ok: false, kind: resolved, code: "unknown_kind", reason: `类型 ${resolved} 不抽取文本` };
}

/** 把异常折成失败结果。依赖缺失单列成 no_extractor —— 那是部署形态，不是故障。 */
function toFailure(kind, err) {
  const message = `${err?.name || "Error"}: ${err?.message || String(err)}`.slice(0, 300);
  if (err instanceof ExtractTimeout) {
    return { ok: false, kind, code: "timeout", reason: message };
  }
  if (
    err?.code === "MODULE_NOT_FOUND" ||
    err?.code === "ERR_MODULE_NOT_FOUND" ||
    /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(String(err?.message || ""))
  ) {
    return { ok: false, kind, code: "no_extractor", reason: `没有可用的解析器：${message}` };
  }
  return { ok: false, kind, code: "error", reason: message };
}
