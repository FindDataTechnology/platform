// Live acceptance for ciyuan-account-lane (task 6.3), production.
//
//   node scripts/verify-live-ciyuan-account.mjs
//
// Real Logto account from .env binds the real 词元 trial account (password from
// CIYUAN_TRIAL_PASSWORD or /tmp/ciyuan-trial-newpw.txt — never committed). Then
// three layers are checked against each other: what the user sees (card,
// app-center badge), what the platform reports (/api/connections), and what
// the machines hold (the cell's dsh credential file carries a key that differs
// from the deployment seed; 词元's api_keys has the yizuo-* row; one real chat
// turn lands a usage row on that key). Finally disconnect and prove the
// fallback, and soft-delete the test key in 词元.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";
const dotenv = (k) => (readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
const TRIAL_EMAIL = process.env.CIYUAN_TRIAL_EMAIL || "ciyuan-trial@findmail.com";
const TRIAL_PASSWORD =
  process.env.CIYUAN_TRIAL_PASSWORD || (existsSync("/tmp/ciyuan-trial-newpw.txt") ? readFileSync("/tmp/ciyuan-trial-newpw.txt", "utf8").trim() : null);
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set");
if (!TRIAL_PASSWORD) throw new Error("CIYUAN_TRIAL_PASSWORD not set");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000 }).trim();
const kexec = (script) => sh("kubectl", ["--context", "cheap", "-n", "fd-prod", "exec", "deploy/platform", "--", "sh", "-c", script]);
const psql = (sql) => sh("kubectl", ["--context", "cheap", "-n", "sub2api", "exec", "sub2api-postgres-0", "--", "psql", "-U", "sub2api", "-d", "sub2api", "-t", "-A", "-F", "|", "-c", sql]);

// Cells whose dsh credential file carries a 词元 provider key DIFFERENT from
// every deployment-seed value — the machine-side proof of the per-user
// override. Provider ids are deployment data (finddata / finddata-token), so
// compare values, not ids. Prints only cell id + key prefix + length.
function overriddenCells() {
  const out = kexec(
    `SEEDS=$(node -e "const c=require('/data/llm-providers.json'); console.log((c.providers||[]).map(p=>p.apiKey).filter(Boolean).join('\\n'))"); ` +
      `for f in /data/cells/*/dsh/.credentials.yaml; do v=$(grep -E '^ *(LLM_API_KEY|LLM_PROVIDER_KEY_[A-Z0-9_]+):' "$f" | sed -E "s/^[^:]+: *['\\"]?([^'\\"]*)['\\"]?/\\1/" | head -1); ` +
      `if [ -n "$v" ] && ! printf '%s\\n' "$SEEDS" | grep -qxF "$v"; then echo "$(echo $f | cut -d/ -f4) $(echo $v | cut -c1-6)… len$(echo -n $v | wc -c | tr -d ' ')"; fi; done`,
  );
  return out ? out.split("\n").filter(Boolean) : [];
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ locale: "zh-CN" })).newPage();
let mintedKeyId = null;
try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("sso-login").click();
  const id = page.locator('input[name="identifier"]');
  await id.waitFor({ state: "visible", timeout: 30_000 }); await id.fill(EMAIL); await id.press("Enter");
  const pw = page.locator('input[name="password"]');
  await pw.waitFor({ state: "visible", timeout: 30_000 }); await pw.fill(PASSWORD); await pw.press("Enter");
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  ok("login", true, page.url());

  const conns = async () => page.evaluate(async () => Object.fromEntries((await (await fetch("/api/connections")).json()).connections.map((c) => [c.id, c])));
  const before = await conns();
  ok("/api/connections carries ciyuan-account and no line-wanxing-caller", "ciyuan-account" in before && !("line-wanxing-caller" in before), Object.keys(before).join(","));
  ok("no cell overridden before binding", overriddenCells().length === 0, overriddenCells().join("; ") || "none");

  // ── bind ──────────────────────────────────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections?panel=ciyuan-account`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("ciyuan-account-card").waitFor({ state: "visible", timeout: 30_000 });
  ok("deep link highlights the 词元 card", (await page.locator("[data-panel='ciyuan-account']").getAttribute("data-panel-active")) === "true");
  const state0 = await page.getByTestId("ciyuan-account-state").getAttribute("data-state");
  if (state0 !== "disconnected") {
    console.log(`  (card starts ${state0}; disconnecting first for a clean run)`);
    await page.getByTestId("ciyuan-account-disconnect").click();
    await page.getByTestId("ciyuan-account-state").waitFor({ state: "visible" });
  }
  await page.getByTestId("ciyuan-account-email").fill(TRIAL_EMAIL);
  await page.getByTestId("ciyuan-account-password").fill(TRIAL_PASSWORD);
  await page.getByTestId("ciyuan-account-connect").click();
  await page.locator("[data-testid='ciyuan-account-state'][data-state='connected']").waitFor({ timeout: 30_000 });
  ok("card connected after zero-paste bind", true);
  const details = await page.getByTestId("ciyuan-account-details").innerText();
  const keyName = details.match(/yizuo-[0-9a-f]{8}-\d{8}/)?.[0] ?? null;
  ok("key name rendered, no key material", Boolean(keyName) && !/sk-/.test(details), keyName ?? details.slice(0, 80));
  ok("password field cleared after bind", (await page.getByTestId("ciyuan-account-password").count()) === 0 || (await page.getByTestId("ciyuan-account-password").inputValue()) === "");
  ok("lane note says the model lane bills the user (cell form)", (await page.getByTestId("ciyuan-account-lane-note").innerText()).includes("词元额度"));

  const after = await conns();
  ok("aggregation: ciyuan-account connected", after["ciyuan-account"]?.state === "connected", JSON.stringify(after["ciyuan-account"]));

  const cells = overriddenCells();
  ok("exactly one cell carries the user's key (the binder's cell)", cells.length === 1, cells.join("; ") || "none");

  const row = psql(`SELECT id, group_id, user_id, status FROM api_keys WHERE name='${keyName}' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`);
  mintedKeyId = row.split("|")[0] || null;
  ok("词元 api_keys has the minted yizuo-* row in group 3 under the trial user (93)", /^\d+\|3\|93\|/.test(row), row || "(none)");

  await page.goto(`${PLATFORM}/apps`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("app-center-grid").waitFor({ state: "visible", timeout: 30_000 });
  ok("app-center 词元 card badge connected", (await page.getByTestId("app-card-wanxing-token-connection-badge").getAttribute("data-state")) === "connected");
  ok("app-center 词元 card has no 去连接", (await page.getByTestId("app-card-wanxing-token-connect").count()) === 0);

  // ── probe ─────────────────────────────────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections?panel=ciyuan-account`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("ciyuan-account-test").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("ciyuan-account-test").click();
  await page.getByTestId("ciyuan-account-probe").waitFor({ state: "visible", timeout: 20_000 });
  ok("probe answers HTTP 200 with the minted key", (await page.getByTestId("ciyuan-account-probe").innerText()).includes("HTTP 200"));

  // ── one real chat turn → usage row on the minted key (billing subject) ───
  const usageBefore = mintedKeyId ? Number(psql(`SELECT count(*) FROM usage_logs WHERE api_key_id=${mintedKeyId}`)) : -1;
  try {
    await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const input = page.getByTestId("composer-input");
    await input.waitFor({ state: "visible", timeout: 30_000 });
    // The bind rewrote the dsh credential store + MCP patches moments ago; let
    // the hot reloads settle before the turn, or the first send races them.
    await page.waitForTimeout(4000);
    await input.fill("只回复两个字：收到");
    await input.press("Enter");
    await page.getByTestId("turn-assistant").last().waitFor({ state: "visible", timeout: 90_000 });
    // 词元 writes usage rows asynchronously — poll up to 30s for the row.
    let usageAfter = usageBefore;
    for (let i = 0; i < 10 && usageAfter <= usageBefore; i++) {
      await page.waitForTimeout(3000);
      usageAfter = mintedKeyId ? Number(psql(`SELECT count(*) FROM usage_logs WHERE api_key_id=${mintedKeyId}`)) : -1;
    }
    ok("chat turn billed to the user's minted key (usage_logs row)", usageAfter > usageBefore, `rows ${usageBefore} → ${usageAfter}`);
  } catch (e) {
    ok("chat turn billed to the user's minted key (usage_logs row)", false, `chat did not complete: ${String(e?.message || e).slice(0, 100)}`);
  }

  // ── disconnect → fallback ─────────────────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections?panel=ciyuan-account`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("ciyuan-account-disconnect").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("ciyuan-account-disconnect").click();
  await page.locator("[data-testid='ciyuan-account-state'][data-state='disconnected']").waitFor({ timeout: 30_000 });
  ok("card disconnected with the revoke hint", (await page.getByTestId("ciyuan-account-notice").innerText()).includes("token.finddatatech.cloud"));
  ok("aggregation back to disconnected", (await conns())["ciyuan-account"]?.state === "disconnected");
  ok("cell credential file fell back to the deployment seed", overriddenCells().length === 0, overriddenCells().join("; ") || "none");
} finally {
  await browser.close();
  if (mintedKeyId) {
    const del = psql(`UPDATE api_keys SET deleted_at=now() WHERE id=${mintedKeyId} AND deleted_at IS NULL RETURNING id`);
    console.log(`  test key ${mintedKeyId} soft-deleted in 词元: ${del || "(already gone)"}`);
  }
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
