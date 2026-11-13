#!/usr/bin/env python3
"""会话存档 SDK helper：把 C 库包成按行 JSON 协议。

为什么要这个进程（不是直接在 Node 里调）：
  Node 不能 dlopen 一个 C 库。要么写 N-API addon（镜像里带编译工具链），
  要么把库放到一个子进程后面。选后者：`.so` 与 RSA 私钥只活在这个进程里，
  Node 侧拿不到；而且换绑定语言不影响上层。

协议（stdin/stdout 各一行一个 JSON）：
  {"op":"ping"}                                  → {"ok":true,"egressIp":"..."}
  {"op":"getChatData","seq":0,"limit":1000}      → {"ok":true,"seq":N,"messages":[...]}
  {"op":"decryptData","encryptRandomKey":..,"encryptChatMsg":..} → {"ok":true,"plain":".."}
  {"op":"getMediaData","sdkFileId":..,"indexBuf":..} → {"ok":true,"chunkBase64":..,"outIndexBuf":..}

失败时统一 {"ok":false,"errCode":N,"message":".."}，由 Node 侧 classify() 翻成具名异常。

⚠ SLICE_LAYOUT 是桩库的布局。拿到官方头文件后，对照改这一处（其余逻辑不依赖它）。
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import subprocess
import sys
from ctypes import POINTER, Structure, c_char_p, c_int, c_uint, c_ulonglong, c_void_p, string_at

SDK_PATH = os.environ.get("ARCHIVE_SDK_PATH", "")
PRIVATE_KEY_PATH = os.environ.get("ARCHIVE_PRIVATE_KEY", "")

# 这两个错误码必须与通用协议错误分开：私钥没配是"还没准备好"，不是"数据坏了"。
# 混在一起会让现场去查网络/SDK，而真正缺的是一把没挂上来的私钥。
ERR_KEY_MISSING = 9005
ERR_RSA_FAILED = 9006


class PrivateKeyNotConfigured(RuntimeError):
    """私钥没挂上来。要报"未配置"，不能静默返回空明文。"""


class RsaDecryptError(RuntimeError):
    """私钥在，但解不开这串密文（公钥私钥不配对、或密文被截断）。"""


def rsa_decrypt_random_key(encrypt_random_key: str, key_path: str = "") -> str:
    """把 `encrypt_random_key` 解成 SDK 需要的 AES 密钥。

    官方设计：`encrypt_random_key = base64( RSA_PKCS#1 v1.5( aes_key, 企业公钥 ) )`。
    必须先用企业自己持有的**私钥**解出 `aes_key`（一串 base64 文本），再交给
    `DecryptData(aes_key, encrypt_chat_msg)`。

    跳过这一步、把密文直接当密钥喂给 SDK，表现是**每条消息都解密失败**——而且
    错误来自 SDK 内部，看起来像"消息格式不对"，很难倒推到 RSA 这一层。

    实现走 openssl 子进程而不是 Python 三方库：客户机器上几乎一定有 openssl，
    而 cryptography/pycryptodome 不一定装得进去，也不该为一次解密引入轮子。
    """
    key_file = key_path or PRIVATE_KEY_PATH
    if not key_file:
        raise PrivateKeyNotConfigured(
            "未配置私钥（ARCHIVE_PRIVATE_KEY），无法解 encrypt_random_key"
        )
    if not os.path.exists(key_file):
        raise PrivateKeyNotConfigured(f"私钥文件不存在：{key_file}")

    raw = str(encrypt_random_key or "").strip()
    if not raw:
        raise RsaDecryptError("encrypt_random_key 为空")
    try:
        cipher = base64.b64decode(raw, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise RsaDecryptError(f"encrypt_random_key 不是合法 base64：{exc}") from exc

    try:
        proc = subprocess.run(
            [
                os.environ.get("ARCHIVE_OPENSSL", "openssl"),
                "pkeyutl",
                "-decrypt",
                "-inkey",
                key_file,
                "-pkeyopt",
                "rsa_padding_mode:pkcs1",
            ],
            input=cipher,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except FileNotFoundError as exc:
        raise RsaDecryptError("找不到 openssl，无法解 encrypt_random_key") from exc
    except subprocess.TimeoutExpired as exc:
        raise RsaDecryptError("openssl 解密超时") from exc

    if proc.returncode != 0:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip()[:200]
        raise RsaDecryptError(f"RSA 解密失败（检查公钥/私钥是否配对）：{detail}")

    # 解出来的是密钥文本（base64 的 ASCII）。不做二次 base64 解码：
    # SDK 的 DecryptData 期望的就是这串文本。
    try:
        return proc.stdout.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise RsaDecryptError(f"RSA 解密结果不是文本：{exc}") from exc


class Slice(Structure):
    # 官方布局（2026-11-12 两份独立镜像交叉核对，逐字一致）：
    #     typedef struct Slice_t { char* buf; int len; } Slice_t;
    # 早先这里多了一个 out_indexbuf 字段——那是把"媒体分片索引"错当成 Slice 的成员。
    # 真正的媒体结构是 MediaData_t（见下），官方 GetOutIndexBuf 收的也是它。
    # buf 用 c_void_p 而不是 c_char_p：后者按 NUL 截断，媒体二进制必坏。
    _fields_ = [
        ("buf", c_void_p),
        ("len", c_int),
    ]


class MediaData(Structure):
    #     typedef struct MediaData { char* outindexbuf; int out_len;
    #                                char* data; int data_len; int is_finish; } MediaData_t;
    # 与 Slice_t 是**两个不同的结构体**。混用会让真库按错误的偏移读内存。
    _fields_ = [
        ("outindexbuf", c_char_p),
        ("out_len", c_int),
        ("data", c_void_p),
        ("data_len", c_int),
        ("is_finish", c_int),
    ]


def load_sdk(path: str):
    if not path:
        raise RuntimeError("未配置 ARCHIVE_SDK_PATH")
    lib = ctypes.CDLL(path)
    lib.NewSdk.restype = c_void_p
    lib.NewSdk.argtypes = []
    lib.DestroySdk.argtypes = [c_void_p]
    lib.DestroySdk.restype = None
    lib.NewSlice.restype = POINTER(Slice)
    lib.NewSlice.argtypes = []
    lib.FreeSlice.argtypes = [POINTER(Slice)]
    lib.FreeSlice.restype = None
    lib.Init.argtypes = [c_void_p, c_char_p, c_char_p]
    lib.Init.restype = c_int
    # 注意参数顺序：GetChatData 是 (sdk, seq, limit, proxy, passwd, timeout, out)；
    # GetMediaData 是 (sdk, **indexbuf, sdkFileid**, proxy, passwd, timeout, out)。
    # 两者顺序不同，写反了不会报错，只会一直返回同一块或空块。
    lib.GetChatData.argtypes = [
        c_void_p, c_ulonglong, c_uint, c_char_p, c_char_p, c_int, POINTER(Slice)
    ]
    lib.GetChatData.restype = c_int
    lib.DecryptData.argtypes = [c_char_p, c_char_p, POINTER(Slice)]
    lib.DecryptData.restype = c_int
    lib.GetMediaData.argtypes = [
        c_void_p, c_char_p, c_char_p, c_char_p, c_char_p, c_int, POINTER(MediaData)
    ]
    lib.GetMediaData.restype = c_int
    # 取内容用 GetContentFromSlice —— 官方没有 GetSliceData 这个符号。
    lib.GetContentFromSlice.argtypes = [POINTER(Slice)]
    lib.GetContentFromSlice.restype = c_void_p
    lib.GetSliceLen.argtypes = [POINTER(Slice)]
    lib.GetSliceLen.restype = c_int
    # 媒体侧的读接口（Python 等语言专用，官方头文件里明确列了）
    lib.NewMediaData.restype = POINTER(MediaData)
    lib.NewMediaData.argtypes = []
    lib.FreeMediaData.argtypes = [POINTER(MediaData)]
    lib.FreeMediaData.restype = None
    lib.GetOutIndexBuf.argtypes = [POINTER(MediaData)]
    lib.GetOutIndexBuf.restype = c_char_p
    lib.GetData.argtypes = [POINTER(MediaData)]
    lib.GetData.restype = c_void_p
    lib.GetIndexLen.argtypes = [POINTER(MediaData)]
    lib.GetIndexLen.restype = c_int
    lib.GetDataLen.argtypes = [POINTER(MediaData)]
    lib.GetDataLen.restype = c_int
    lib.IsMediaDataFinish.argtypes = [POINTER(MediaData)]
    lib.IsMediaDataFinish.restype = c_int
    return lib


class Helper:
    def __init__(self, lib, corpid: str, secret: str):
        self.lib = lib
        self.sdk = lib.NewSdk()
        code = lib.Init(self.sdk, corpid.encode(), secret.encode())
        if code != 0:
            raise RuntimeError(f"Init 失败 errcode={code}")

    def _take_raw(self, ptr) -> bytes:
        """按显式长度取字节——媒体是二进制，不能按 NUL 或 UTF-8 处理。

        取内容走官方的 `GetContentFromSlice`。早先这里调的是 `GetSliceData`，
        那个符号在真库里**不存在**（ctypes 会在加载时就 AttributeError）。
        """
        buf = self.lib.GetContentFromSlice(ptr)
        length = self.lib.GetSliceLen(ptr)
        raw = string_at(buf, length) if buf and length > 0 else b""
        self.lib.FreeSlice(ptr)
        return raw

    def _take(self, ptr) -> str:
        return self._take_raw(ptr).decode("utf-8", "replace")

    def ping(self) -> dict:
        # 出口 IP 由部署环境声明，不在这里探测（helper 不做网络）
        return {"ok": True, "egressIp": os.environ.get("ARCHIVE_EGRESS_IP", "")}

    def get_chat_data(self, seq: int, limit: int) -> dict:
        ptr = self.lib.NewSlice()
        code = self.lib.GetChatData(
            self.sdk, c_ulonglong(seq), c_uint(limit), None, None, 30, ptr
        )
        text = self._take(ptr)

        # 官方回的是**信封**：{"errcode":0,"errmsg":"ok","chatdata":[...]}
        # 早先这里把返回值当裸数组 `json.loads(text or "[]")`。真机上它会解析成一个
        # dict，而下游 `isinstance(messages, list)` 为假 → **每批都"成功"但零条消息**，
        # 游标照常推进。那是最坏的一种错：拉取器全绿、数据永远为空。
        if code != 0:
            return {"ok": False, "errCode": code, "message": text or "GetChatData failed"}

        try:
            envelope = json.loads(text or "{}")
        except json.JSONDecodeError:
            return {"ok": False, "errCode": 1099, "message": f"返回不是 JSON：{text[:120]}"}

        if isinstance(envelope, list):
            # 只用于兼容桩/自建实现；真 SDK 不会这样回。
            messages = envelope
        elif isinstance(envelope, dict):
            env_code = int(envelope.get("errcode") or 0)
            env_msg = str(envelope.get("errmsg") or "")
            # 信封里的 errcode 必须单独看：C 调用可能返回 0 而信封里报错。
            if env_code != 0:
                return {
                    "ok": False,
                    "errCode": env_code,
                    "message": env_msg or f"信封 errcode={env_code}",
                }
            chatdata = envelope.get("chatdata")
            if not isinstance(chatdata, list):
                # 形状变了就明说，不静默当"没有新消息"。
                return {
                    "ok": False,
                    "errCode": 1099,
                    "message": f"信封里没有 chatdata 数组：{text[:120]}",
                }
            messages = chatdata
        else:
            return {"ok": False, "errCode": 1099, "message": f"返回形状不认识：{text[:120]}"}

        # 游标：按本批消息自带的 seq 取最大值推进。官方 GetChatData 不直接回新游标，
        # 每条消息里带 seq；回显请求值会导致游标永远不动、反复拉同一批。
        max_seq = seq
        key_versions = set()
        for m in messages:
            if not isinstance(m, dict):
                continue
            try:
                s_val = int(m.get("seq", 0))
            except (TypeError, ValueError):
                continue
            if s_val > max_seq:
                max_seq = s_val
            ver = m.get("publickey_ver")
            if ver is not None:
                try:
                    key_versions.add(int(ver))
                except (TypeError, ValueError):
                    pass
        return {
            "ok": True,
            "seq": max_seq,
            "messages": messages,
            # 私钥只对应一个版本；出现多个版本时 10007（找不到对应版本私钥）迟早会来。
            # 提前把版本号带出来，省得现场去猜。
            "keyVersions": sorted(key_versions),
        }

    def decrypt(self, random_key: str, chat_msg: str) -> dict:
        # 第一步：RSA 解出 AES 密钥。少了这一步，SDK 收到的是密文而不是密钥，
        # 每条消息都会解密失败——而错看起来像"消息格式不对"。
        try:
            aes_key = rsa_decrypt_random_key(random_key)
        except PrivateKeyNotConfigured as exc:
            return {"ok": False, "errCode": ERR_KEY_MISSING, "message": str(exc)}
        except RsaDecryptError as exc:
            return {"ok": False, "errCode": ERR_RSA_FAILED, "message": str(exc)}

        ptr = self.lib.NewSlice()
        code = self.lib.DecryptData(aes_key.encode(), chat_msg.encode(), ptr)
        plain = self._take(ptr)
        if code != 0:
            return {"ok": False, "errCode": code, "message": plain or "DecryptData failed"}
        return {"ok": True, "plain": plain}

    def get_media(self, sdk_file_id: str, index_buf: str) -> dict:
        # 媒体走 MediaData_t（不是 Slice_t）。官方读接口：GetData / GetDataLen /
        # GetOutIndexBuf / IsMediaDataFinish，全部收 MediaData_t*。
        ptr = self.lib.NewMediaData()
        code = self.lib.GetMediaData(
            self.sdk, index_buf.encode(), sdk_file_id.encode(), None, None, 30, ptr
        )
        try:
            data_ptr = self.lib.GetData(ptr)
            data_len = self.lib.GetDataLen(ptr)
            next_buf = self.lib.GetOutIndexBuf(ptr)
            finished = self.lib.IsMediaDataFinish(ptr)
            raw = string_at(data_ptr, data_len) if data_ptr and data_len > 0 else b""
            if isinstance(next_buf, bytes):
                next_str = next_buf.decode("utf-8", "replace")
            else:
                next_str = next_buf or ""
        finally:
            self.lib.FreeMediaData(ptr)

        if code != 0:
            return {
                "ok": False,
                "errCode": code,
                "message": raw.decode("utf-8", "replace") or "GetMediaData failed",
            }
        return {
            "ok": True,
            "chunkBase64": base64.b64encode(raw).decode("ascii"),
            "outIndexBuf": next_str,
            # 完成标记用官方的 is_finish，不靠"没有下一块"推断。
            "isFinish": bool(finished),
        }


def main() -> int:
    try:
        lib = load_sdk(SDK_PATH)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "errCode": 9001, "message": str(exc)}), flush=True)
        return 1

    corpid = os.environ.get("ARCHIVE_CORPID", "")
    secret = os.environ.get("ARCHIVE_SECRET", "")
    helper = None
    init_error = None
    try:
        helper = Helper(lib, corpid, secret)
    except Exception as exc:  # noqa: BLE001
        init_error = str(exc)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "errCode": 9002, "message": "bad json"}), flush=True)
            continue

        op = req.get("op")
        if op == "ping":
            payload = (
                {"ok": True, "egressIp": os.environ.get("ARCHIVE_EGRESS_IP", "")}
                if helper
                else {"ok": False, "errCode": 9003, "message": f"Init 未通过：{init_error}"}
            )
        elif helper is None:
            payload = {"ok": False, "errCode": 9003, "message": f"Init 未通过：{init_error}"}
        elif op == "getChatData":
            payload = helper.get_chat_data(int(req.get("seq", 0)), int(req.get("limit", 1000)))
        elif op == "decryptData":
            payload = helper.decrypt(
                str(req.get("encryptRandomKey", "")), str(req.get("encryptChatMsg", ""))
            )
        elif op == "getMediaData":
            payload = helper.get_media(
                str(req.get("sdkFileId", "")), str(req.get("indexBuf", ""))
            )
        else:
            payload = {"ok": False, "errCode": 9004, "message": f"unknown op {op}"}

        print(json.dumps(payload, ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
