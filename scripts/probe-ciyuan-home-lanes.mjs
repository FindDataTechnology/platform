// 首页对齐 + 视频块浏览器验收（show-ciyuan-video-on-home 2.3/2.4）。
// 匿名访问 https://router.finddatatech.cloud/home：
//   ① 四张车道卡：量每卡 .meter 距卡底距离（应一致≈贴底）
//   ② 视频段存在：#fdr-video 可见 + 端点在正文
// 双宽（桌面 1280 / 窄屏 390）跑两轮。
import { chromium } from 'playwright';

const BASE = process.env.CIYUAN_BASE || 'https://router.finddatatech.cloud';
const widths = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
];

const browser = await chromium.launch();
let failed = 0;
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'networkidle', timeout: 45000 });

  // ① 四张车道卡：每卡 item 底边 - meter 底边
  const gaps = await page.$$eval('#fdr-lanes .lane', (lanes) =>
    lanes.map((lane) => {
      const m = lane.querySelector('.meter');
      if (!m) return null;
      const lr = lane.getBoundingClientRect();
      const mr = m.getBoundingClientRect();
      return Math.round(lr.bottom - mr.bottom);
    })
  );
  const gapStr = JSON.stringify(gaps);
  const nonNull = gaps.filter((g) => g !== null);
  const spread = nonNull.length ? Math.max(...nonNull) - Math.min(...nonNull) : -1;
  const aligned = nonNull.length === 4 && spread <= 3;
  console.log(`[${w.name}] lane card count=${gaps.length} meter gaps=${gapStr} spread=${spread}px ${aligned ? 'AIM ✓' : 'AIM ✗'}`);
  if (!aligned) failed++;

  // ② 视频段存在
  const videoOk = await page.evaluate(() => {
    const sec = document.querySelector('#fdr-video');
    if (!sec) return { ok: false, why: 'no #fdr-video section' };
    const text = sec.textContent || '';
    const hasEndpoint = text.includes('/v1/contents/generations/tasks');
    const hasCreate = text.includes('创建');
    const hasPoll = text.includes('轮询');
    const visible = sec.getBoundingClientRect().height > 50;
    return { ok: hasEndpoint && hasCreate && hasPoll && visible, hasEndpoint, hasCreate, hasPoll, visible };
  });
  console.log(`[${w.name}] video section: ${JSON.stringify(videoOk)} ${videoOk.ok ? 'VIDEO ✓' : 'VIDEO ✗'}`);
  if (!videoOk.ok) failed++;

  // ③ 车道段导语口径更新
  const lead = await page.$eval('#fdr-lanes .lead', (el) => el.textContent.trim().slice(0, 80)).catch(() => '');
  const leadOk = lead.includes('视频生成');
  console.log(`[${w.name}] lanes lead has 视频生成: ${leadOk ? '✓' : '✗'} "${lead.slice(0, 50)}..."`);
  if (!leadOk) failed++;

  await page.screenshot({ path: `/tmp/ciyuan-home-${w.name}.png`, fullPage: false });
  await ctx.close();
}
await browser.close();
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
