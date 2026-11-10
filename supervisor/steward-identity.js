// ── Steward identity: key custody, pairing, silent re-login (add-cell-lifecycle 4.1)
//
// One desktop steward = one Ed25519 keypair whose private half NEVER leaves
// the machine and never sits in plaintext:
//   macOS    `security` CLI generic-password entry  (platform-steward / cellId)
//   Windows  DPAPI-sealed blob <dataDir>/.steward-keyv1.dpapi
//            (CryptProtectData, CurrentUser scope — another profile on the
//            same machine cannot open it; a legacy plaintext .steward-keyv1
//            is migrated on first read)
//   others   vault file <dataDir>/.steward-keyv1 (default-fs ACL inside the
//            owner's data root — documented baseline)
//
// Pairing rides the gateway's app-auth verbatim (same bind-code redemption);
// the only addition it brings is `kind: "steward"` so the returned Bearer
// token opens exactly one door (cell lifecycle reporting) and nothing else.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const SERVICE = "platform-steward";
const DPAPI_ENTROPY = "platform-steward-v1";
const DPAPI_FILE = ".steward-keyv1.dpapi";
const LEGACY_FILE = ".steward-keyv1";

// DPAPI without a native addon: one PowerShell (5.1-compatible) invocation per
// protect/unprotect. Only runs at pair / silent-refresh time, never per request.
// The payload rides stdin, so no secret ever appears in an argv (visible in the
// process list). EncodedCommand sidesteps all quoting.
export function runPowerShell(script, input = "", { timeoutMs = 15000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      child = spawnFn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
    } catch { return resolve(null); }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort */ }
      resolve(null);
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => { /* diagnostics are not part of the contract */ });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      resolve(out.trim() || null);
    });
    try { child.stdin.end(input); } catch { /* best-effort */ }
  });
}

const DPAPI_HEAD = `
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Security | Out-Null } catch {}
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$raw = [Console]::In.ReadToEnd()
`;
const DPAPI_PROTECT = `${DPAPI_HEAD}
$bytes = [Text.Encoding]::UTF8.GetBytes($raw)
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;
const DPAPI_UNPROTECT = `${DPAPI_HEAD}
$enc = [Convert]::FromBase64String($raw)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

export function createWindowsDpapi({ run = runPowerShell } = {}) {
  return {
    async protect(plain) { return plain ? run(DPAPI_PROTECT, plain) : null; },
    async unprotect(blob) { return blob ? run(DPAPI_UNPROTECT, blob) : null; },
  };
}

export function createKeyStorage({ cellId, dataDir, execP = execFileP, dpapi }) {
  const fallbackFile = path.join(dataDir, LEGACY_FILE);
  const dpapiFile = path.join(dataDir, DPAPI_FILE);
  // `dpapi` explicitly passed (incl. null) pins the custody backend — tests
  // drive the Windows path on any OS; production auto-selects by platform.
  const dpapiStore = dpapi !== undefined ? dpapi : (process.platform === "win32" ? createWindowsDpapi() : null);

  async function getMacPassword() {
    try {
      const { stdout } = await execP("security", ["find-generic-password", "-s", SERVICE, "-a", cellId, "-w"]);
      const v = String(stdout).trim();
      return v || null;
    } catch { return null; }
  }

  function writeDpapi(blob) {
    const tmp = `${dpapiFile}.tmp`;
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, dpapiFile);
  }

  return {
    async get() {
      if (process.platform === "darwin") {
        const v = await getMacPassword();
        if (v) return v;
      }
      if (dpapiStore && fs.existsSync(dpapiFile)) {
        const blob = fs.readFileSync(dpapiFile, "utf8").trim();
        // Sealed bytes that will not open mean the identity is gone (profile
        // reset); never silently fall back to a plaintext leftover.
        return blob ? await dpapiStore.unprotect(blob).catch(() => null) : null;
      }
      if (fs.existsSync(fallbackFile)) {
        const legacy = fs.readFileSync(fallbackFile, "utf8").trim() || null;
        if (legacy && dpapiStore) {
          // One-time migration: seal, then drop the plaintext copy.
          const blob = await dpapiStore.protect(legacy).catch(() => null);
          if (blob) { writeDpapi(blob); fs.rmSync(fallbackFile, { force: true }); }
        }
        return legacy;
      }
      return null;
    },
    async set(privB64) {
      if (process.platform === "darwin") {
        await execP("security", ["add-generic-password", "-s", SERVICE, "-a", cellId, "-w", privB64, "-U"]).catch(() => {});
      }
      if (dpapiStore) {
        const blob = await dpapiStore.protect(privB64).catch(() => null);
        if (blob) { writeDpapi(blob); fs.rmSync(fallbackFile, { force: true }); return; }
      }
      fs.writeFileSync(fallbackFile, privB64, { mode: 0o600 });
    },
    async remove() {
      if (process.platform === "darwin") {
        await execP("security", ["delete-generic-password", "-s", SERVICE, "-a", cellId]).catch(() => {});
      }
      fs.rmSync(dpapiFile, { force: true });
      fs.rmSync(fallbackFile, { force: true });
    },
  };
}

// RFC 8032 wire shape the gateway expects: base64url of the RAW 32-byte key.
export function generateDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" }).d;
  return { pubkeyB64Url: pub.x, privateKeyB64Url: priv };
}

const fetchJson = async (url, { method = "GET", headers = {}, body = null } = {}) => {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body == null ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// First pairing: bind code → token. On failure the identity is NOT stored —
// a rejected pair must not leave a half-bound steward behind.
export async function pairSteward({ gatewayUrl, code, deviceId, label, storage, fetchImpl = fetchJson }) {
  const keys = generateDeviceKeypair();
  const { status, body } = await fetchImpl(`${gatewayUrl}/api/app/pair`, {
    method: "POST",
    body: { code: String(code ?? "").trim(), deviceId, pubkey: keys.pubkeyB64Url, label: label ?? null, kind: "steward" },
  });
  if (status !== 200 || !body?.token) {
    return { ok: false, status, error: body?.error ?? `pair failed (${status})` };
  }
  await storage.set(keys.privateKeyB64Url);
  return { ok: true, token: body.token, email: body.email ?? null, deviceId };
}

// Silent re-login: challenge → sign(deviceId:nonce) → login → new token.
export async function refreshStewardToken({ gatewayUrl, deviceId, storage, fetchImpl = fetchJson }) {
  const priv = await storage.get();
  if (!priv) return null;
  const c = await fetchImpl(`${gatewayUrl}/api/app/challenge`, { method: "POST", body: { deviceId } });
  if (c.status !== 200 || !c.body?.nonce) return null;
  // A corrupt local key means the pair is dead — answer null (the caller's
  // second-401 path then burns the identity honestly).
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: priv, x: undefined }, format: "jwk" });
  } catch { return null; }
  const signature = crypto.sign(null, Buffer.from(`${deviceId}:${c.body.nonce}`), privateKey).toString("base64url");
  const l = await fetchImpl(`${gatewayUrl}/api/app/login`, { method: "POST", body: { deviceId, nonce: c.body.nonce, signature } });
  return l.status === 200 && l.body?.token ? l.body.token : null;
}
