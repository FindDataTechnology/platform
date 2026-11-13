// ── 上传前的本地闸门（发文件的任务 3.x）─────────────────────────────────────
//
// 三道闸都在**发请求之前**做完，理由很实际：这类错误一旦靠"腾讯把请求拒了"来暴露，
// 排查的人第一个会怀疑凭据和出口 IP，而真正的原因只是"文件 21MB"或"这其实是张图片
// 改了个 .xlsx 后缀"。本地拒绝能把原因写在离动作最近的地方。
//
//   ① 路径：必须是允许根内的**常规文件**；拒绝 URL 与不存在的路径（不做远程抓取，
//      否则"发个文件给客户"就有了一条 SSRF 与任意读取的通道）。
//   ② 体积：官方 > 5 字节、普通文件 ≤ 20MB（口径与出处见 api.js 常量注释）。
//   ③ 类型：扩展名白名单 + 头部 magic 双校验，不一致即拒绝——**不猜**。
//
// 纯函数：只读文件、不写不删、不发请求，所以能逐格断言。

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { UPLOAD_MAX_BYTES, UPLOAD_MIN_BYTES } from "./api.js";

/** 允许外发的扩展名。办公文档 + 文本，够客服场景用；其余一律要显式改代码放宽。 */
export const ALLOWED_EXTENSIONS = new Set([
  ".xlsx",
  ".xls",
  ".csv",
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".txt",
  ".zip",
]);

// 头部字节 → 家族。xlsx/docx/pptx 都是 ZIP 容器，所以只能核到"是 ZIP"这一层；
// 再往里拆包判断属于过度设计，且会把一份合法但用非标准实现导出的表判死。
const MAGIC = {
  zip: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  cfb: (b) =>
    b.length >= 8 &&
    b[0] === 0xd0 &&
    b[1] === 0xcf &&
    b[2] === 0x11 &&
    b[3] === 0xe0 &&
    b[4] === 0xa1 &&
    b[5] === 0xb1 &&
    b[6] === 0x1a &&
    b[7] === 0xe1,
  pdf: (b) =>
    b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  // 文本没有 magic：用"前 8KB 没有 NUL"作为"看起来是文本"的保守判据。
  text: (b) => !b.subarray(0, 8192).includes(0x00),
};

/** 扩展名 → 允许的魔数家族。扩展名与家族不符即拒绝。 */
const EXPECT = {
  ".xlsx": ["zip"],
  ".docx": ["zip"],
  ".pptx": ["zip"],
  ".zip": ["zip"],
  ".xls": ["cfb"],
  ".doc": ["cfb"],
  ".pdf": ["pdf"],
  ".csv": ["text"],
  ".txt": ["text"],
};

const SNIFF_BYTES = 8192;

/**
 * 校验一份待上传的本地文件。
 *
 * @param {object} input
 * @param {string} input.filePath    调用方给的路径
 * @param {string} input.allowedRoot 允许的文件根（一般是 KF_MEDIA_DIR）
 * @returns {{ok:true, name:string, bytes:number, buffer:Buffer, realPath:string}
 *          |{ok:false, reason:string}}
 */
export function inspectUpload({ filePath, allowedRoot } = {}) {
  const raw = String(filePath ?? "").trim();
  if (!raw) return { ok: false, reason: "未给出文件路径" };

  // ① URL 一律不接：这是"发本地文件"，不是"帮我把某个地址抓下来再发出去"。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return { ok: false, reason: "只接受本地文件路径，不接受远程地址" };
  }

  let real;
  try {
    real = realpathSync(raw);
  } catch {
    return { ok: false, reason: `文件不存在或不可读：${raw}` };
  }

  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, reason: `无法读取文件状态：${raw}` };
  }
  if (!st.isFile()) return { ok: false, reason: "不是常规文件" };

  // 允许根用 realpath 再比，否则 symlink 可以绕过（根内一个链到 /etc 的软链）。
  if (allowedRoot) {
    let root;
    try {
      root = realpathSync(String(allowedRoot));
    } catch {
      return { ok: false, reason: `允许根不可用：${allowedRoot}` };
    }
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, reason: `文件不在允许目录内：${raw}` };
    }
  }

  const name = path.basename(real);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `不允许的文件类型：${ext || "（无扩展名）"}` };
  }

  // ② 体积：先看 stat，省得把 200MB 的文件读进内存再拒绝。
  if (st.size < UPLOAD_MIN_BYTES) {
    return { ok: false, reason: `文件 ${st.size} 字节，小于官方最小 ${UPLOAD_MIN_BYTES} 字节` };
  }
  if (st.size > UPLOAD_MAX_BYTES) {
    return { ok: false, reason: `文件 ${st.size} 字节，超过官方上限 ${UPLOAD_MAX_BYTES}` };
  }

  let buffer;
  try {
    buffer = readFileSync(real);
  } catch (err) {
    return { ok: false, reason: `读取失败：${err?.message || err}` };
  }

  // ③ 类型：扩展名说它是 X，头部就得像 X。对不上就是有人改了后缀（或文件坏了）。
  const head = buffer.subarray(0, SNIFF_BYTES);
  const families = EXPECT[ext] || [];
  const matched = families.some((f) => MAGIC[f]?.(head));
  if (!matched) {
    return {
      ok: false,
      reason: `文件内容与扩展名 ${ext} 不符（头部不像 ${families.join("/")}）`,
    };
  }

  return { ok: true, name, bytes: buffer.length, buffer, realPath: real };
}
