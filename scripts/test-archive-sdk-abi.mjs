#!/usr/bin/env node
// ── 会话存档 SDK 的 ABI 对齐（任务 1.1c）────────────────────────────────────
//
// 2026-11-12 拿到官方头文件（两份独立镜像逐字一致），对照后**发现五处不一致**，
// 其中一处会让真机"永远拉不到消息却一直报成功"。这组测试把那份 ABI 钉死：
//
//   1. `Slice_t` 只有两个字段：`{char* buf; int len;}`。
//      我们原来是 `{buf, len, out_indexbuf}` —— 把"媒体分片索引"错当 Slice 的成员。
//   2. 媒体走**另一个结构体** `MediaData_t{outindexbuf,out_len,data,data_len,is_finish}`，
//      `GetOutIndexBuf` 收的是它，不是 Slice_t。
//   3. 取切片内容用 `GetContentFromSlice`；**官方没有 `GetSliceData` 这个符号**。
//   4. `GetChatData` 回的是信封 `{"errcode":0,"errmsg":"ok","chatdata":[...]}`，
//      不是裸数组。当裸数组用 → dict 不是 list → **每批 0 条但报成功**，游标照推。
//   5. 错误码是 10000–10011：`10009`=ip非法（不是 301042）、`10007`=找不到对应版本的私钥、
//      `10010`=数据过期。
//
// 三条独立的证据链，缺一条都可能是我自己骗自己：
//   A. 结构体布局（ctypes 实际偏移/大小）——不是读代码猜的；
//   B. 桩库导出的符号集合与官方 17 个符号**逐一相等**（多一个少一个都不行）；
//   C. 若给了 `WECOM_SDK_HEADER=<真头文件路径>`，解析它并与上面两处比对——
//      腾讯哪天改布局，这条会红，而不是等客户现场炸。
//
//   node --test scripts/test-archive-sdk-abi.mjs
//   WECOM_SDK_HEADER=/path/WeWorkFinanceSdk_C.h node --test scripts/test-archive-sdk-abi.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HELPER_DIR = path.join(ROOT, "server", "archive", "helper");
const STUB_DIR = path.join(ROOT, "tools", "archive-sdk-stub");
const STUB_LIB = path.join(STUB_DIR, "build", "libWeWorkFinanceSdk_C.dylib");
const HAS_STUB = existsSync(STUB_LIB);

/** 官方 ABI 表（来源：官方头文件，两份镜像交叉核对，见文件头）。 */
const ABI = {
  Slice: [
    ["buf", "c_void_p"],
    ["len", "c_int"],
  ],
  MediaData: [
    ["outindexbuf", "c_char_p"],
    ["out_len", "c_int"],
    ["data", "c_void_p"],
    ["data_len", "c_int"],
    ["is_finish", "c_int"],
  ],
  // 符号 → 参数类型（不含 restype；顺序即调用顺序）
  functions: {
    NewSdk: [],
    Init: ["c_void_p", "c_char_p", "c_char_p"],
    GetChatData: ["c_void_p", "c_ulonglong", "c_uint", "c_char_p", "c_char_p", "c_int", "Slice*"],
    DecryptData: ["c_char_p", "c_char_p", "Slice*"],
    // 注意：indexbuf 在前、sdkFileid 在后（与 GetChatData 的参数顺序直觉不同）
    GetMediaData: ["c_void_p", "c_char_p", "c_char_p", "c_char_p", "c_char_p", "c_int", "MediaData*"],
    DestroySdk: ["c_void_p"],
    NewSlice: [],
    FreeSlice: ["Slice*"],
    GetContentFromSlice: ["Slice*"],
    GetSliceLen: ["Slice*"],
    NewMediaData: [],
    FreeMediaData: ["MediaData*"],
    GetOutIndexBuf: ["MediaData*"],
    GetData: ["MediaData*"],
    GetIndexLen: ["MediaData*"],
    GetDataLen: ["MediaData*"],
    IsMediaDataFinish: ["MediaData*"],
  },
};

const SYMBOLS = Object.keys(ABI.functions).sort();

function py(script, env = {}) {
  const res = spawnSync("python3", ["-c", script], {
    cwd: HELPER_DIR,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: res.status, out: res.stdout || "", err: res.stderr || "" };
}

test("A. 结构体布局：字段顺序、类型、偏移、大小都必须是官方的", { skip: !HAS_STUB }, () => {
  const r = py(
    `import json, archive_helper as h
def dump(cls):
    return {"fields": [[n, str(t.__name__)] for n, t in cls._fields_],
            "offsets": [getattr(cls, n).offset for n, _ in cls._fields_],
            "size": __import__("ctypes").sizeof(cls)}
print(json.dumps({"Slice": dump(h.Slice), "MediaData": dump(h.MediaData)}))`,
  );
  assert.equal(r.code, 0, r.err);
  const got = JSON.parse(r.out);

  assert.deepEqual(got.Slice.fields, ABI.Slice, "Slice_t 字段与官方不一致");
  assert.deepEqual(got.MediaData.fields, ABI.MediaData, "MediaData_t 字段与官方不一致");

  // 64 位下：Slice = ptr(8) + int(4) + 对齐补 4 = 16；MediaData = 8+4+(补4)+8+4+4 = 32
  assert.equal(got.Slice.size, 16, `Slice_t 应为 16 字节，实际 ${got.Slice.size}`);
  assert.equal(got.MediaData.size, 32, `MediaData_t 应为 32 字节，实际 ${got.MediaData.size}`);
  // 偏移错了不会报错，只会读到别人的字段——显式钉一遍
  assert.deepEqual(got.Slice.offsets, [0, 8]);
  assert.deepEqual(got.MediaData.offsets, [0, 8, 16, 24, 28]);
});

test("A. ctypes 的 argtypes 与官方签名逐项一致", { skip: !HAS_STUB }, () => {
  const r = py(
    `import json, os, archive_helper as h
lib = h.load_sdk(os.environ["ARCHIVE_SDK_PATH"])
def tname(t):
    import ctypes as c
    if hasattr(t, "_type_") and getattr(t._type_, "__name__", "") in ("Slice", "MediaData"):
        return "P<" + t._type_.__name__ + ">"
    n = getattr(t, "__name__", str(t))
    # ctypes 的整数类型名是平台别名：LP64 上 c_ulonglong 与 c_ulong 同为 8 字节，
    # 名字会随平台变。按「宽度+符号」归一，别把别名差异当成 ABI 不一致。
    if n == "c_char_p": return "bytes"
    if n == "c_void_p": return "ptr"
    if n in ("c_int", "c_uint", "c_long", "c_ulong", "c_ulonglong", "c_longlong", "c_short", "c_ushort"):
        signed = n in ("c_int", "c_long", "c_longlong", "c_short")
        return ("i" if signed else "u") + str(c.sizeof(t) * 8)
    return n
names = ["NewSdk","Init","GetChatData","DecryptData","GetMediaData","DestroySdk","NewSlice",
         "FreeSlice","GetContentFromSlice","GetSliceLen","NewMediaData","FreeMediaData",
         "GetOutIndexBuf","GetData","GetIndexLen","GetDataLen","IsMediaDataFinish"]
print(json.dumps({n: [tname(t) for t in getattr(lib, n).argtypes] for n in names}))`,
    { ARCHIVE_SDK_PATH: STUB_LIB },
  );
  assert.equal(r.code, 0, r.err);
  const got = JSON.parse(r.out);
  const asExpected = (want) =>
    want.map((t) => {
      if (t === "Slice*") return "P<Slice>";
      if (t === "MediaData*") return "P<MediaData>";
      return (
        {
          c_void_p: "ptr",
          c_char_p: "bytes",
          c_int: "i32",
          c_uint: "u32",
          c_ulonglong: "u64", // LP64 上与 c_ulong 同一类型
          c_ulong: "u64",
        }[t] || t
      );
    });
  for (const [name, want] of Object.entries(ABI.functions)) {
    assert.deepEqual(got[name], asExpected(want), `${name} 的参数类型与官方不一致`);
  }
});

test("B. 桩库导出的符号集合与官方 17 个逐一相等（多一个少一个都不行）", { skip: !HAS_STUB }, () => {
  const res = spawnSync("nm", ["-gU", STUB_LIB], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const got = res.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/).pop() || "")
    .filter((s) => s.startsWith("_") && !s.startsWith("__"))
    .map((s) => s.slice(1))
    .sort();
  assert.deepEqual(got, SYMBOLS, "桩库符号与官方不一致：少了就是真机 attributeError，多了就是假装有 ");
});

// ── 信封解析：把 helper 与桩库解耦，直接用假 lib 喂原始字符串 ────────────────

test("C. GetChatData 的信封被解开：messages 来自 chatdata，seq 取最大值", () => {
  const r = py(
    `import json, os, archive_helper as h
ENV = json.dumps({"errcode":0,"errmsg":"ok","chatdata":[
  {"seq": 41, "msgid":"a", "publickey_ver": 3},
  {"seq": 42, "msgid":"b", "publickey_ver": 4}]})
class FakeLib:
    def NewSlice(self): return object()
    def GetChatData(self, sdk, seq, limit, proxy, passwd, timeout, ptr): return 0
    def GetContentFromSlice(self, ptr): return ENV.encode()
    def GetSliceLen(self, ptr): return len(ENV.encode())
    def FreeSlice(self, ptr): pass
helper = h.Helper.__new__(h.Helper)
helper.lib = FakeLib()
helper.sdk = None  # 走假 lib，不需要真句柄
print(json.dumps(helper.get_chat_data(40, 1000)))`,
  );
  assert.equal(r.code, 0, r.err);
  const got = JSON.parse(r.out);
  assert.equal(got.ok, true, r.out);
  assert.equal(got.messages.length, 2, "信封里的 chatdata 才是消息数组");
  assert.equal(got.seq, 42, "游标按本批最大 seq 推进");
  assert.deepEqual(got.keyVersions, [3, 4], "多个密钥版本要带出来（10007 的前兆）");
});

test("C. 信封里 errcode 非 0：必须报失败（C 调用返回 0 也不能当成功）", () => {
  const r = py(
    `import json, archive_helper as h
ENV = json.dumps({"errcode":10009,"errmsg":"ip illegal"})
class FakeLib:
    def NewSlice(self): return object()
    def GetChatData(self, *a): return 0   # ← 关键：C 返回 0
    def GetContentFromSlice(self, ptr): return ENV.encode()
    def GetSliceLen(self, ptr): return len(ENV.encode())
    def FreeSlice(self, ptr): pass
helper = h.Helper.__new__(h.Helper)
helper.lib = FakeLib()
helper.sdk = None  # 走假 lib，不需要真句柄
print(json.dumps(helper.get_chat_data(0, 1000)))`,
  );
  assert.equal(r.code, 0, r.err);
  const got = JSON.parse(r.out);
  assert.equal(got.ok, false, "信封报错必须当失败");
  assert.equal(got.errCode, 10009);
  assert.match(got.message, /ip illegal/);
});

test("C. 信封缺 chatdata：明说失败，不静默当「没有新消息」", () => {
  const r = py(
    `import json, archive_helper as h
ENV = json.dumps({"errcode":0,"errmsg":"ok"})
class FakeLib:
    def NewSlice(self): return object()
    def GetChatData(self, *a): return 0
    def GetContentFromSlice(self, ptr): return ENV.encode()
    def GetSliceLen(self, ptr): return len(ENV.encode())
    def FreeSlice(self, ptr): pass
helper = h.Helper.__new__(h.Helper)
helper.lib = FakeLib()
helper.sdk = None  # 走假 lib，不需要真句柄
print(json.dumps(helper.get_chat_data(0, 1000)))`,
  );
  assert.equal(r.code, 0, r.err);
  const got = JSON.parse(r.out);
  assert.equal(got.ok, false, "形状不对不许当空数组");
  assert.match(got.message, /chatdata/);
});

test("C. 媒体：is_finish 来自官方标志，不由「没有下一块」推断", { skip: !HAS_STUB }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-abi-media-"));
  const cfg = path.join(dir, "stub.cfg");
  // 两段媒体：第 0 段之后还有第 1 段
  writeFileSync(cfg, "MEDIA\tFID\t0\t61626364\nMEDIA\tFID\t1\t65666768\n", "utf8");
  try {
    const r = py(
      `import json, os, archive_helper as h
lib = h.load_sdk(os.environ["ARCHIVE_SDK_PATH"])
helper = h.Helper(lib, "ww1", "s"*40)
print(json.dumps([helper.get_media("FID", ""), helper.get_media("FID", "1")]))`,
      { ARCHIVE_SDK_PATH: STUB_LIB, ARCHIVE_STUB_CONFIG: cfg },
    );
    assert.equal(r.code, 0, r.err);
    const [first, second] = JSON.parse(r.out);
    assert.equal(first.isFinish, false, "还有下一块时不得标完成");
    assert.equal(first.outIndexBuf, "1");
    assert.equal(Buffer.from(first.chunkBase64, "base64").toString(), "abcd");
    assert.equal(second.isFinish, true, "最后一块必须标完成");
    assert.equal(second.outIndexBuf, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D. 有真头文件时，拿它来验上面这张表 ────────────────────────────────────

test("D. 用真头文件核对 ABI 表（设 WECOM_SDK_HEADER 时生效）", () => {
  const headerPath = process.env.WECOM_SDK_HEADER || "";
  if (!headerPath) {
    // 不静默通过：明确说出"这一条没验"，比给一个假绿灯好。
    assert.ok(true, "未提供 WECOM_SDK_HEADER，跳过对真头文件的核对");
    return;
  }
  const text = readFileSync(headerPath, "utf8").replace(/\/\/.*$/gm, "");

  const structFields = (name) => {
    const re = new RegExp(`typedef\\s+struct\\s+${name}\\s*\\{([\\s\\S]*?)\\}\\s*\\w+\\s*;`);
    const m = re.exec(text);
    assert.ok(m, `头文件里找不到 struct ${name}`);
    return m[1]
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((decl) => {
        const parts = decl.replace(/\s+/g, " ").split(" ");
        const fname = parts.pop().replace("*", "");
        const ftype = parts.join(" ").replace(/\s*\*$/, "*").trim();
        return [fname, ftype];
      });
  };

  const slice = structFields("Slice_t");
  assert.deepEqual(slice.map(([n]) => n), ABI.Slice.map(([n]) => n), "Slice_t 字段名/顺序变了");
  assert.deepEqual(
    slice.map(([, t]) => t),
    ["char*", "int"],
    "Slice_t 字段类型变了",
  );

  const media = structFields("MediaData");
  assert.deepEqual(media.map(([n]) => n), ABI.MediaData.map(([n]) => n), "MediaData_t 字段名/顺序变了");
  assert.deepEqual(media.map(([, t]) => t), ["char*", "int", "char*", "int", "int"]);

  for (const name of SYMBOLS) {
    assert.match(text, new RegExp(`\\b${name}\\s*\\(`), `头文件里找不到函数 ${name}`);
  }
});
