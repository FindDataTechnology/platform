#!/usr/bin/env node
// ── 会话存档：RSA 解 encrypt_random_key（任务 1.2b）────────────────────────
//
// 官方设计：`encrypt_random_key = base64( RSA_PKCS#1 v1.5( aes_key, 企业公钥 ) )`。
// 必须先用自己的私钥解出 `aes_key`，再交给 `DecryptData(aes_key, encrypt_chat_msg)`。
//
// 跳过这一步的后果很隐蔽：helper 直接把密文当密钥喂给 SDK，**每条消息都解密失败**，
// 而报错来自 SDK 内部、看起来像"消息格式不对"——很难倒推到 RSA 这一层。
// 这组测试用**固定密钥对 + 固定密文**（不依赖腾讯 SDK，也不随机生成）验证四条：
//
//   1. 解得出来：已知明文能还原
//   2. 私钥没配 → 明说"未配置"，不是空明文
//   3. 公钥私钥不配对 → 单独一类错误（修法完全不同）
//   4. helper 真的把**解出来的密钥**传给 DecryptData，而不是把密文原样递过去
//
//   node --test scripts/test-archive-rsa.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HELPER_DIR = path.join(ROOT, "server", "archive", "helper");

/** 固定测试密钥对（2048 位，仅用于测试；不是任何真实企业的密钥）。 */
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCV65PR5m+mKBkD
ZkqCSbIAy38dUj+o2Ydh8cqj1Y0CyqrUzqhxc/v8eXKwqT/NgjQemoplZIHLPV6k
0Miht0ERDgyfbGREzKOZUOaKE+JdjR3kWGjZWjx51qCAc4/kLp9LdlzN8Fo5igyH
ja07V1R4UsLAFMb0Az4oxW4sN2k4ylOUEWzqMuRXk/Bz3PsFeOt5ZHRbyfx2wntG
9MalOfkPHtW5dWpprYATSEH414E0uRZRBmFHOBBdncfdDjHhOiKS8g/HCW/foNFv
vzqJImQnoSS1/RzHX2PcsNdSPkEw1wYq9SQS8w+uhSnxoV116n2GnA1whE6c4WmL
nZB89KY9AgMBAAECggEAJSEAjTune4xTM40WF2HWgI1laBbaVsA23/owsDYfc+lK
+STMQTrTFbJjRd7IwyYDr++gpl9HqNTEV4ewpKJcrjNfS21eAM74lmwbiGdHyNj9
5fNCVlAbiaYuvllAcefdAiSoc8VapwTqOPkMxdVJQXpnqogKxNx3vMO2lyNK/yn1
jihGJbWjhXfo7DVfpEWnR3e6LQfKwpphcgVfMiutjXcBhZYMFAvwgy+PYXQ/YQjr
UIMgST0gqdJp/zBVn8Z/coOK1p/fvcnYci1kmo8gjGBd6gdHvNK7booX48KPDfBL
gmpq976X9s+XT0r5q9dUWeMc6Yj/q2kVH/4JqegA+QKBgQDHzZLPEWyPT1IEiIDX
XQXLIwj0oeXP/1ZXWKc05gVm5uU+9buqW8UX3Y/YLOPxycweDEngPv2d5730ZwR4
Etqey3YJAumSIOoigMiIFYwluzwwWNIUo/gAV/RNL4WWdeVi3KzIm4tzc3ZQO3At
llx/Glnrv4qPOCmgka1wkzsW1QKBgQDAFkpfh57cmHBxwVxi2S2gt0eOZf5oHq8X
DNp0O1xekBwcOvHy93GLWl7iJhTd1pOMwI89c/K7IBMQ4bMzXgP7tp+xw+uG9D2B
1eJJdFwr8B20l+LbP3/I6nL+T34ULnXZGD09T4vsWUkCfk879z6301geI+E+52i4
gzcwdI9VyQKBgDXsJh3aLvkySAlPKa51vXWIPAeBlfsfhxbFp0KgfX66+82VFhOw
9q0tL4ABBXegpYTKfjmV5m5yN5K5JrydIgFPGcjuz0iPt4CeTwBjCFK6iFDn97J4
WhsFobofBCeKI+Ede0gcqnL7C0g18l1rQgVPgEseg2+Jkbpy9mL2aTENAoGAFk1A
O1Eqr5//RiXWDR/7/THqW+0ZmYsedwWmA2K0+cGvkdOCLdxu0WgfphAX0h3MqcXd
m5vvrawuqoIZ5TfgLIRqjCAcI2IOFhn4GOEqpmtNd58+1ofL1U7rJP2jvMIcKqV2
zryCmWFQabqyhlrRbFRcYbt2tm/1p56MdNLDpYkCgYBzjfxCqJvEHEHOiD0CiNnR
vQt5whVv5rhZFFLiz6lcqCpT1sqFaj12To8DqwU4aeBEf5yCCnpK0mycHD+ltbvU
cK4Ae1grxc1eKvzD/5XcgI6ajFUdcZPfdlT5Qq4e0ypOtsV0otjBjTzdcp0GDIyg
zTqXM0A/Hq6I1fL31IhaSQ==
-----END PRIVATE KEY-----`;

/** 用上面这把钥匙加密的已知明文（PKCS#1 v1.5）。 */
const TEST_AES_KEY = "S6kqA1bW9XfLmT2oPzR8uYdE4hJcNg";
const TEST_CIPHER_B64 =
  "afGyLFiSSapppF4h3hTOmn3t5BAXqYkgOyFS/cMe3uf6lqE/FZgj+jVcvdDfpbzJNSBiG5+VUU4TZO1heY/nHltkl/kB8ArOxjB4fttqfvgoZEfPw2d9EX/JhJSGuslfoOu7sj8J+lOlGP7pmVHkb1GV4mCrkcpfglPhUuPjDMxYCgUTp8Bs8wlik/K5lK4OuzRJHZpf8k5Yir2m8u2oAGEgvspPwZZn0ZaPm47kUPesMOXa9lz0vpMQ7SetMlHaVqCseWJMPf3+IZsuIky1SqIaOqHIEont9pGkG4qxj7xtoPlwU367GvaeHc5k4E1fEb3Xz2qDuZSjQ8Nmoakr/w==";

function withKey(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-rsa-"));
  const keyPath = path.join(dir, "private.pem");
  writeFileSync(keyPath, TEST_PRIVATE_KEY, { mode: 0o600 });
  try {
    return fn(keyPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在 helper 目录里跑一段 python，返回 { code, stdout, stderr }。 */
function py(script, args = [], env = {}) {
  const res = spawnSync("python3", ["-c", script, ...args], {
    cwd: HELPER_DIR,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: res.status, out: res.stdout || "", err: res.stderr || "" };
}

test("固定密钥对 + 固定密文 → 解出已知明文", () => {
  withKey((keyPath) => {
    const r = py(
      "import sys, archive_helper as h; print(h.rsa_decrypt_random_key(sys.argv[1]))",
      [TEST_CIPHER_B64],
      { ARCHIVE_PRIVATE_KEY: keyPath },
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), TEST_AES_KEY, `解出值不对：${r.out} ${r.err}`);
  });
});

test("私钥未配置：报「未配置」，不是返回空明文", () => {
  withKey(() => {
    const r = py(
      `import archive_helper as h
try:
    print(h.rsa_decrypt_random_key(${JSON.stringify(TEST_CIPHER_B64)}))
except h.PrivateKeyNotConfigured as e:
    print("NOT_CONFIGURED:", e)
`,
      [],
      { ARCHIVE_PRIVATE_KEY: "" },
    );
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("NOT_CONFIGURED"), r.out || r.err);
    assert.ok(!r.out.includes(TEST_AES_KEY));
  });
});

test("私钥文件不存在：同样归「未配置」（不是 RSA 失败）", () => {
  const r = py(
    `import archive_helper as h
try:
    print(h.rsa_decrypt_random_key(${JSON.stringify(TEST_CIPHER_B64)}, "/nonexistent/k.pem"))
except h.PrivateKeyNotConfigured as e:
    print("NOT_CONFIGURED:", e)
except h.RsaDecryptError as e:
    print("RSA_FAILED:", e)
`,
  );
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("NOT_CONFIGURED"), r.out || r.err);
});

test("公钥私钥不配对：单独一类错误（不是「未配置」）", () => {
  withKey((_keyPath, dir) => {
    const other = path.join(dir, "other.pem");
    const gen = spawnSync("openssl", ["genrsa", "-out", other, "2048"], { encoding: "utf8" });
    assert.equal(gen.status, 0, gen.stderr);
    const r = py(
      `import sys, archive_helper as h
try:
    print(h.rsa_decrypt_random_key(sys.argv[1], sys.argv[2]))
except h.PrivateKeyNotConfigured as e:
    print("NOT_CONFIGURED:", e)
except h.RsaDecryptError as e:
    print("RSA_FAILED:", e)
`,
      [TEST_CIPHER_B64, other],
    );
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("RSA_FAILED"), `配错钥匙应报 RSA 失败：${r.out} ${r.err}`);
  });
});

// 最关键的一条：helper 真的把解出来的密钥交给 DecryptData。
// 用假 lib 记录 DecryptData 收到的第一个参数——如果它等于密文，说明 RSA 那步没接上，
// 而这在真机上只会表现为"每条消息都解密失败"。
test("helper 把解出的密钥传给 DecryptData（而不是把密文原样递过去）", () => {
  withKey((keyPath) => {
    const r = py(
      `import sys, archive_helper as h

seen = {}
class FakeLib:
    def NewSlice(self): return None
    def DecryptData(self, key, msg, ptr):
        seen["key"] = key.decode()
        return 1
    # 官方读接口是 GetContentFromSlice（没有 GetSliceData 这个符号）
    def GetContentFromSlice(self, ptr): return None
    def GetSliceLen(self, ptr): return 0
    def FreeSlice(self, ptr): pass

helper = h.Helper.__new__(h.Helper)
helper.lib = FakeLib()
out = helper.decrypt(sys.argv[1], "encrypted-chat-msg")
print("KEY_SEEN:" + seen.get("key", "<none>"))
print("OK:" + str(out.get("ok")))
`,
      [TEST_CIPHER_B64],
      { ARCHIVE_PRIVATE_KEY: keyPath },
    );
    assert.equal(r.code, 0, r.err);
    assert.ok(
      r.out.includes(`KEY_SEEN:${TEST_AES_KEY}`),
      `DecryptData 收到的不是解出的密钥：${r.out} ${r.err}`,
    );
    assert.ok(!r.out.includes(`KEY_SEEN:${TEST_CIPHER_B64}`), "不能把密文当密钥用");
  });
});

test("Node 侧把 9005/9006 翻成具名异常（不是通用协议错误）", async () => {
  const { classify, KEY_MISSING_CODE, RSA_DECRYPT_CODE } = await import(
    "../server/archive/sdk.js"
  );
  assert.equal(KEY_MISSING_CODE, 9005);
  assert.equal(RSA_DECRYPT_CODE, 9006);
  assert.equal(classify(9005, "x").name, "PrivateKeyNotConfiguredError");
  assert.equal(classify(9006, "解不开").name, "RsaDecryptError");
  // 其余错误仍然是通用协议错误，不猜含义
  assert.equal(classify(1099, "其他").name, "SdkProtocolError");
});
