// Settings → WeChat App (openspec: add-mp-scan-bind, tasks 2.2 and 2.3).
//
// The section exists to hand ONE secret to a phone in two shapes, so the
// assertions that matter are that the digits are six digits and that the
// rendered QR decodes — with a real decoder, not by re-reading the string we
// passed in — to the URL the mini program's parser expects. Everything else
// here is the settings-surface contract the new section participates in.
//
// It runs against a second server.js spawned with AUTH_MODE=forward_auth: the
// shared webServer runs open (mode none), where this section's honest answer is
// "this instance has no accounts". Minting needs a real signed-in identity, so
// the spec supplies one the way the deployment's proxy does — forwarded
// identity headers — and the bind code is minted by the REAL route.

import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pinLocaleEn, prepareTempStoreDirs } from "./helpers.js";

const require = createRequire(import.meta.url);
const JSQR = require.resolve("jsqr/dist/jsQR.js");

// What the forward-auth proxy injects in front of the app (server/auth.js).
const IDENTITY = { "x-forwarded-email": "binder@corp.com", "x-forwarded-groups": "users" };

const BIND_LABEL = "WeChat App";
// The canonical section order the settings-surface delta declares, relative to
// each other. The surface also carries the Account section, which that delta
// does not enumerate — so this asserts the order of the declared ones rather
// than the whole list.
const CANONICAL = ["general", "models", "mcp", "skills", "wechat-app", "status"];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

let PORT;
let BASE;
let child;
let bootLog = "";
// Its own tree: this spec boots a second server, so it must not share the
// webServer's stores (see prepareTempStoreDirs).
const stores = prepareTempStoreDirs({ subdir: "wechat-app" });

// Read the six digits the section is currently showing.
async function shownCode(page) {
  const text = await page.getByTestId("mp-binding-code").innerText();
  expect(text.trim()).toMatch(/^\d{6}$/);
  return text.trim();
}

// Rasterize the rendered SVG into a canvas and read it back with a real QR
// decoder — the same direction a camera would go. A wrong module sequence, a
// mis-scaled grid, or a code drawn from a different string all fail here.
async function decodeShownQr(page) {
  return page.evaluate(async () => {
    const svg = document.querySelector('[data-testid="mp-binding-qr"] svg');
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

test.describe("settings → WeChat App", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ extraHTTPHeaders: IDENTITY });

  test.beforeAll(async () => {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    child = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        AUTH_MODE: "forward_auth",
        CHAT_HISTORY_STORE_DIR: stores.chat,
        DOCUMENTS_STORE_DIR: stores.docs,
        SESSIONS_STORE_DIR: stores.sessions,
        DB_PATH: stores.db,
        // DSH_HOME is not inherited by workers: without this the child would
        // compose against — and rewrite — the developer's real ~/.dsh.
        DSH_HOME: stores.dshHome,
        DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));

    // Readiness: the route this spec depends on must answer with a code BEFORE
    // the browser tests run — "the port is open" is not the contract here.
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
      throw new Error(`bind-code server not ready: ${lastErr?.message}\n${bootLog.slice(-2000)}`);
    }
  });

  test.afterAll(async () => {
    if (child) {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    fs.rmSync(stores.root, { recursive: true, force: true });
  });

  test("the section shows a code whose QR decodes to the bind URL", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/wechat-app`);
    await page.addScriptTag({ path: JSQR });

    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "wechat-app");
    await expect(page.getByTestId("settings-wechat-app")).toBeVisible();

    const code = await shownCode(page);
    expect(await decodeShownQr(page)).toBe(`${BASE}/settings/wechat-app?bindcode=${code}`);
  });

  test("refresh re-mints the digits and the QR together", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/wechat-app`);
    await page.addScriptTag({ path: JSQR });

    const first = await shownCode(page);
    const firstQr = await decodeShownQr(page);
    expect(firstQr).toContain(`bindcode=${first}`);

    await page.getByTestId("mp-binding-refresh").click();
    await expect.poll(() => shownCode(page), { timeout: 15000 }).not.toBe(first);

    const second = await shownCode(page);
    expect(second).not.toBe(first);
    expect(await decodeShownQr(page)).toBe(`${BASE}/settings/wechat-app?bindcode=${second}`);
  });

  test("a 401 degrades to the sign-in hint, leaving the rest of Settings usable", async ({ page }) => {
    await page.route("**/api/mp/bindcode", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Authentication required" }),
      }),
    );
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/wechat-app`);

    await expect(page.getByTestId("wechat-app-sign-in")).toBeVisible();
    await expect(page.getByTestId("mp-binding-code")).toHaveCount(0);
    await expect(page.getByTestId("mp-binding-qr")).toHaveCount(0);

    // Not a blocking error: the other sections still open.
    await page.getByTestId("settings-section-status").click();
    await expect(page).toHaveURL(/\/settings\/status$/);
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
  });

  test("the modal lists the declared sections in order and routes as before", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto(`${BASE}/settings/wechat-app`);
    await page.getByTestId(`settings-section-wechat-app`).filter({ hasText: BIND_LABEL }).waitFor();

    const order = await page.$$eval('[data-testid^="settings-section-"]', (els) =>
      els.map((el) => el.getAttribute("data-testid")),
    );
    const wanted = CANONICAL.map((slug) => `settings-section-${slug}`);
    expect(order.filter((id) => wanted.includes(id))).toEqual(wanted);

    // The section list speaks the active locale; the slug does not follow it.
    await expect(page.getByTestId("settings-section-wechat-app")).toContainText(BIND_LABEL);

    await page.goto(`${BASE}/settings`);
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");

    await page.goto(`${BASE}/settings/not-a-section`);
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");
  });
});