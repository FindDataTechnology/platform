// /lanes 白屏修复生产验收（fix-ciyuan-lanes-white-screen 5.1-5.4）。
// 真登录链（.env 测试账号 → 词元 router 域 OIDC）→ 打开 /lanes：
//   ① URL 停在 /lanes 且 BODY 非空（白屏反例=BODY len 0）
//   ② 四行车卡片渲染（rerank/websearch/ASR/TTS 文案可见）
//   ③ 控制台无 Unterminated closing brace / 未捕获异常
//   ④ zh/en 两语言各测一轮（切 locale cookie 或直接断言 zh；en 用 ?lang 或 localStorage）
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('/Users/chengsishi/paas/.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const ID = env.PAAS_TEST_IDENTIFIER;
const PW = env.PAAS_TEST_PASSWORD;
if (!ID || !PW) { console.error('missing PAAS_TEST_* in .env'); process.exit(2); }

const BASE = 'https://router.finddatatech.cloud';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let failed = 0;
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};

// 1. 登录：router 域 /login → OIDC
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(2000);
console.log('  at:', page.url());

// 词元登录页：找 OIDC 按钮（等渲染）
const oidcBtn = page.locator('button:has-text("Continue with OIDC"), a:has-text("Continue with OIDC"), button:has-text("OIDC")').first();
await oidcBtn.waitFor({ timeout: 20000 }).catch(() => {});
if (await oidcBtn.count() > 0) {
  await oidcBtn.click();
  await page.waitForLoadState('domcontentloaded');
} else {
  console.log('  no OIDC button found; page text head:', (await page.locator('body').innerText()).slice(0, 300));
}
console.log('  after click:', page.url());

// 2. auth 域两步表单
if (page.url().includes('auth.finddatatech.cloud')) {
  await page.waitForSelector('input[name="identifier"]', { timeout: 30000 });
  await page.fill('input[name="identifier"]', ID);
  await page.keyboard.press('Enter');
  await page.waitForSelector('input[name="password"]', { timeout: 30000 });
  await page.fill('input[name="password"]', PW);
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.hostname.includes('auth.finddatatech.cloud'), { timeout: 45000 });
}
await page.waitForLoadState('networkidle', { timeout: 45000 });
console.log('  logged in, at:', page.url());

// 3. 直达 /lanes
await page.goto(`${BASE}/lanes`, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(3000); // 等 vue 渲染

const bodyLen = (await page.locator('body').innerText()).length;
ok('BODY 非空（白屏反例=0）', bodyLen > 50, `BODY len: ${bodyLen}`);
ok('URL 停在 /lanes', page.url().includes('/lanes'), page.url());

const text = await page.locator('body').innerText();
// 四行卡片证据：车道名 + 端点（zh 或 en 都接受）
const hasRerank = /\/(v1\/rerank)/.test(text) && /(重排|Rerank)/i.test(text);
const hasSearch = /\/(v1\/search)/.test(text) && /(搜索|Web search)/i.test(text);
const hasAsr = /audio\/transcriptions/.test(text) && /(转写|Speech-to-text)/i.test(text);
const hasTts = /audio\/speech/.test(text) && /(合成|Text-to-speech)/i.test(text);
ok('rerank 行渲染', hasRerank);
ok('websearch 行渲染', hasSearch);
ok('ASR 行渲染', hasAsr);
ok('TTS 行渲染', hasTts);

// 形状文案（修复的具体内容）：页面应出现 "请求 {" 或 "Request {" 的完整字面量
const shapeRendered = /请求 \{query|Request \{query/.test(text) || /请求 \{input|Request \{input/.test(text);
ok('shapes 文案完整渲染（引号内字面量）', shapeRendered);

const braceErr = consoleErrors.filter((e) => /Unterminated closing brace|Unbalanced closing brace|SyntaxError/.test(e));
ok('控制台无消息编译错误', braceErr.length === 0, braceErr.slice(0, 2).join(' | ') || 'clean');
ok('控制台无未捕获异常', consoleErrors.filter((e) => e.startsWith('PAGEERROR')).length === 0, consoleErrors.slice(0, 2).join(' | ') || 'clean');

await page.screenshot({ path: '/tmp/ciyuan-lanes-after-fix.png', fullPage: false });

// 4. en 一轮：切换语言（如页面有语言切换则点，否则用 localStorage/i18n 路径跳过并说明）
// 词元面板语言存 localStorage；直接设置后 reload
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (/locale|lang/i.test(k)) localStorage.setItem(k, 'en');
  }
  localStorage.setItem('locale', 'en');
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const textEn = await page.locator('body').innerText();
const _enOk = /Request \{query|Request \{input/.test(textEn) || /Rerank|Rerank/i.test(textEn) || bodyLenOf(textEn) > 50;
function bodyLenOf(s) { return s.length; }
ok('en 轮 BODY 非空', textEn.length > 50, `len=${textEn.length}`);
const braceErrEn = consoleErrors.filter((e) => /Unterminated closing brace/.test(e));
ok('en 轮无编译错误（累计）', braceErrEn.length === 0);
await page.screenshot({ path: '/tmp/ciyuan-lanes-en.png', fullPage: false });

await browser.close();
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
