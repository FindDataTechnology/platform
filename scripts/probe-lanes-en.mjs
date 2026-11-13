import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('/Users/chengsishi/paas/.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')]; }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

// login first (zh default), then set en locale and reload /lanes
await page.goto('https://router.finddatatech.cloud/login', { waitUntil: 'networkidle', timeout: 45000 });
await page.locator('button:has-text("Continue with OIDC")').first().click();
await page.waitForLoadState('domcontentloaded');
if (page.url().includes('auth.finddatatech.cloud')) {
  await page.waitForSelector('input[name="identifier"]', { timeout: 30000 });
  await page.fill('input[name="identifier"]', env.PAAS_TEST_IDENTIFIER);
  await page.keyboard.press('Enter');
  await page.waitForSelector('input[name="password"]', { timeout: 30000 });
  await page.fill('input[name="password"]', env.PAAS_TEST_PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForURL(u => !u.hostname.includes('auth.finddatatech.cloud'), { timeout: 45000 });
}
await page.waitForURL(/dashboard|\/home/, { timeout: 30000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 45000 });
console.log('logged in at:', page.url());
await page.evaluate(() => localStorage.setItem('sub2api_locale', 'en'));
await page.goto('https://router.finddatatech.cloud/lanes', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(3000);
const text = await page.locator('body').innerText();
const len = text.length;
const hasEnRerank = /Request \{query, documents\[\], top_n\}/.test(text);
const hasEnWeb = /Request \{engine, q, num\}/.test(text);
const hasEnTts = /Request \{input, voice, model, response_format\}/.test(text);
const hasRerankRow = /Rerank/.test(text);
const hasSearchRow = /Web search/.test(text);
const hasAsrRow = /Speech-to-text/.test(text);
const hasTtsRow = /Text-to-speech/.test(text);
console.log(`en BODY len=${len}`);
console.log(`rows: Rerank=${hasRerankRow} WebSearch=${hasSearchRow} ASR=${hasAsrRow} TTS=${hasTtsRow}`);
console.log(`shapes literal: rerank=${hasEnRerank} websearch=${hasEnWeb} tts=${hasEnTts}`);
const braceErr = errs.filter(e => /Unterminated|Unbalanced|SyntaxError/.test(e));
console.log(`console errors (compile): ${braceErr.length}${braceErr.length ? ' -> ' + braceErr[0] : ''}`);
console.log(`page errors: ${errs.filter(e => e.startsWith('PAGEERROR')).length}`);
await page.screenshot({ path: '/tmp/ciyuan-lanes-en-real.png' });
await browser.close();
const pass = len > 100 && hasRerankRow && hasSearchRow && hasAsrRow && hasTtsRow && hasEnRerank && hasEnWeb && hasEnTts && braceErr.length === 0;
console.log(pass ? 'EN PASS' : 'EN FAIL');
process.exit(pass ? 0 : 1);
