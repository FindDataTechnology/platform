// Settings → Paired devices (openspec: add-device-pairing-auth, task 4.3).
//
// Four assertions that matter:
//   1. the section is reachable at its deep link and mints a code whose QR
//      really decodes to `<origin>/settings/devices?bindcode=<code>` — the
//      one-capture pairing payload (instance address + code);
//   2. a device paired through the REAL endpoints (a genuine Ed25519
//      keypair, signed challenge — exactly the app's handshake) appears in
//      the web list with its label;
//   3. revoking from the UI removes the device from the list;
//   4. after revocation the server holds nothing: the device's challenge
//      401s with binding_required (the re-pair semantic).
//
// Same harness shape as settings-wechat-app.spec.js — a second server.js
// with AUTH_MODE=forward_auth and proxy-injected identity — plus
// MP_TOKEN_SECRET so the pairing path is live (without it every pairing
// endpoint is inert by design).

import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pinLocaleEn, prepareTempStoreDirs, spawnTestServer } from "./helpers.js";

const require = createRequire(import.meta.url);
const JSQR = require.resolve("jsqr/dist/jsQR.js");

const IDENTITY = { "x-forwarded-email": "pairer@corp.com", "x-forwarded-groups": "users" };
const TOKEN_SECRET = "e2e-app-pairing-secret";
const DEVICE_LABEL = "Pixel 8 (e2e)";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// The app side of the wire contract (gateway/app-auth.js design D2): raw
// 32-byte keys over base64url, signature on `deviceId:nonce`.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function newDeviceKeypair() {
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, crypto.randomBytes(32)]),
    format: "der",
    type: "pkcs8",
  });
  return {
    priv,
    pubkey: crypto.createPublicKey(priv).export({ format: "jwk" }).x,
    sign: (message) => crypto.sign(null, Buffer.from(message, "utf8"), priv).toString("base64url"),
  };
}

let PORT;
let BASE;
let child;
let server;
let bootLog = "";
const stores = prepareTempStoreDirs({ subdir: "app-devices" });

async function shownCode(page) {
  const text = await page.getByTestId("devices-binding-code").innerText();
  expect(text.trim()).toMatch(/^\d{6}$/);
  return text.trim();
}

async function decodeShownQr(page) {
  return page.evaluate(async () => {
    const svg = document.querySelector('[data-testid="devices-binding-qr"] svg');
    if (!svg) return "no svg rendered";
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("the QR SVG did not load as an image"));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    });
    const side = 512;
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, side, side);
    ctx.drawImage(img, 0, 0, side, side);
    const pixels = ctx.getImageData(0, 0, side, side);
    const found = window.jsQR(pixels.data, pixels.width, pixels.height);
    return found ? found.data : "decoder found no code";
  });
}

// Pair a device against the REAL endpoints with a genuine keypair — the
// exact handshake the future app client will run.
async function pairDeviceOverApi(deviceId, label) {
  const device = newDeviceKeypair();
  const mint = await fetch(`${BASE}/api/mp/bindcode`, {
    headers: { ...IDENTITY, accept: "application/json" },
  }).then((r) => r.json());
  const pair = await fetch(`${BASE}/api/app/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: mint.code, deviceId, pubkey: device.pubkey, label }),
  });
  expect(pair.status).toBe(200);
  const challenge = await fetch(`${BASE}/api/app/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  }).then((r) => r.json());
  const login = await fetch(`${BASE}/api/app/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId,
      nonce: challenge.nonce,
      signature: device.sign(`${deviceId}:${challenge.nonce}`),
    }),
  });
  expect(login.status).toBe(200);
  const { token } = await login.json();
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  expect(claims.kind).toBe("app");
  expect(claims.did).toBe(deviceId);
  return { device, token };
}

test.describe("settings → Paired devices", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ extraHTTPHeaders: IDENTITY });

  test.beforeAll(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    server = spawnTestServer({
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        AUTH_MODE: "forward_auth",
        MP_TOKEN_SECRET: TOKEN_SECRET,
        CHAT_HISTORY_STORE_DIR: stores.chat,
        DOCUMENTS_STORE_DIR: stores.docs,
        SESSIONS_STORE_DIR: stores.sessions,
        DB_PATH: stores.db,
        // DSH_HOME is not inherited by workers: without this the child would
        // compose against — and rewrite — the developer's real ~/.dsh.
        DSH_HOME: stores.dshHome,
        DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      },
    });
    child = server.child;
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));

    const start = Date.now();
    let lastErr;
    while (Date.now() - start < 90_000) {
      try {
        const r = await fetch(`${BASE}/api/mp/bindcode`, { headers: { ...IDENTITY, accept: "application/json" } });
        if (r.ok && (await r.json()).code) break;
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (Date.now() - start >= 90_000) {
      throw new Error(`pairing server not ready: ${lastErr?.message}\n${bootLog.slice(-2000)}`);
    }
  });

  test.afterAll(async () => {
    if (server) await server.stop();
    child = null;
    fs.rmSync(stores.root, { recursive: true, force: true });
  });

  test("deep link opens the section; the QR decodes to the pairing URL", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/devices`);
    await page.addScriptTag({ path: JSQR });

    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "devices");
    await expect(page.getByTestId("settings-devices")).toBeVisible();

    const code = await shownCode(page);
    expect(await decodeShownQr(page)).toBe(`${BASE}/settings/devices?bindcode=${code}`);
  });

  test("a device paired through the real handshake appears in the list", async ({ page }) => {
    await pairDeviceOverApi("e2e-device-1", DEVICE_LABEL);
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/devices`);

    const row = page.getByTestId("device-row").filter({ hasText: DEVICE_LABEL });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute("data-device", "e2e-device-1");
    // No device left behind by an empty list flash: exactly the one we paired.
    await expect(page.getByTestId("device-row")).toHaveCount(1);
  });

  test("revoking from the UI removes the device and kills its silent path", async ({ page }) => {
    // device-1 from the previous test is still bound (tests share the server
    // and account); this test pairs a second device, revokes IT, and expects
    // the list to fall back to exactly the untouched sibling.
    await pairDeviceOverApi("e2e-device-2", "iPhone 17 (e2e)");
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/devices`);

    const row = page.getByTestId("device-row").filter({ hasText: "iPhone 17 (e2e)" });
    await row.getByTestId("device-revoke").click();
    await row.getByTestId("device-revoke-confirm").click();

    await expect(page.getByTestId("device-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("device-row").first()).toHaveAttribute("data-device", "e2e-device-1");

    // …and the server agrees: the device is told to re-pair, indistinguishable
    // from never having paired.
    const challenge = await fetch(`${BASE}/api/app/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "e2e-device-2" }),
    });
    expect(challenge.status).toBe(401);
    expect((await challenge.json()).error).toBe("binding_required");
  });

  test("capabilities are advertised for the app's probe", async () => {
    // forward_auth deployments answer anonymous /api/config with 401 (the
    // public-path list is a logto-shape concept) — probe with the same
    // identity the rest of this spec uses.
    const cfg = await fetch(`${BASE}/api/config`, { headers: IDENTITY }).then((r) => r.json());
    expect(cfg.capabilities?.devicePairing).toBe(true);
  });
});
