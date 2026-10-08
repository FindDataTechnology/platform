// ── In-app visual self-test (CI smoke, opt-in via env) ──────────────────────
//
// The v1.3.5 black-screen round proved that process/port checks cannot see
// what the user sees: the backend was healthy and the window still showed a
// flat dark rectangle. External screenshots are no better on a CI runner —
// the desktop session's wallpaper dominates the frame and the app window may
// never appear on the captured display (2026-10-08 Phase C v1: 99.74%
// "non-backdrop pixels", zero of them from the app).
//
// This module lets the app testify about ITSELF, which is the only vantage
// point that is guaranteed to be the same as the user's:
//   1. wait for did-finish-load (the load a black screen never reaches);
//   2. read the live DOM (React mounted? root has children? visible text?);
//   3. capturePage() — the renderer's own framebuffer, on-screen or not;
//   4. write a JSON report + PNG, then exit 0/1.
//
// Enabled only when PLATFORM_SMOKE_SELFTEST is set, so normal runs are
// untouched. The workflow asserts the exit code and uploads the PNG.

import { writeFileSync } from "node:fs";

const WINDOW_BG = [13, 17, 23]; // BrowserWindow backgroundColor #0d1117

export function selftestEnabled() {
  return !!process.env.PLATFORM_SMOKE_SELFTEST;
}

/**
 * Run the self-test against a loaded window. Never throws — writes the report
 * and resolves with { ok, report } so the caller can decide the exit code.
 */
export async function runSmokeSelftest(win, { timeoutMs = 90_000 } = {}) {
  const reportPath = process.env.PLATFORM_SMOKE_REPORT || "";
  const shotPath = process.env.PLATFORM_SMOKE_SHOT || "";
  const report = { ok: false, stages: {}, error: null };

  const deadline = Date.now() + timeoutMs;
  try {
    // 1. The load itself — a black screen never finishes loading. POLL, do not
    // event-wait: a load that completes between an isLoading() check and a
    // once("did-finish-load") listener is a race the listener loses forever
    // (first CI attempt: 90s timeout on a page that had already rendered).
    // The server may redirect (e.g. "/" → "/login" under the logto gate) —
    // that is fine; what matters is that the window reaches a finished load.
    while (win.webContents.isLoading() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (win.webContents.isLoading()) throw new Error(`load did not finish within ${timeoutMs}ms`);
    report.stages.loaded = true;

    // 2. Let React mount + settle (boot does a few API round-trips).
    await new Promise((r) => setTimeout(r, 2500));

    // 3. Live DOM state.
    const dom = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root');
      const text = (document.body && document.body.innerText) || '';
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        rootChildren: root ? root.children.length : -1,
        textLength: text.trim().length,
        textHead: text.trim().slice(0, 120),
        htmlHead: (document.documentElement.outerHTML || '').slice(0, 200),
        hasLogin: !!document.querySelector('[data-testid="login-page"], [data-testid="app-shell"], nav, main, form'),
      };
    })()`);
    report.stages.dom = dom;

    // 4. The renderer's own framebuffer — independent of display visibility.
    let png = null;
    if (win.webContents.capturePage) {
      const image = await win.webContents.capturePage();
      if (!image.isEmpty()) {
        png = image.toPNG();
        if (shotPath) writeFileSync(shotPath, png);
        // Pixel verdict: does the captured frame differ from the flat window
        // backdrop? A mounted SPA spreads text/controls over the viewport.
        const { width, height } = image.getSize();
        const bmp = image.toBitmap(); // BGRA
        let painted = 0;
        let samples = 0;
        for (let y = 0; y < height; y += 4) {
          for (let x = 0; x < width; x += 4) {
            const i = (y * width + x) * 4;
            const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
            samples++;
            if (Math.abs(r - WINDOW_BG[0]) > 12 || Math.abs(g - WINDOW_BG[1]) > 12 || Math.abs(b - WINDOW_BG[2]) > 12) painted++;
          }
        }
        report.stages.pixels = { width, height, painted, samples, pct: Math.round((1000 * painted) / Math.max(1, samples)) / 10 };
      }
    }

    // Verdict: loaded + React mounted with content + frame is not flat.
    const domOk = dom.rootChildren > 0 && dom.textLength > 20;
    const pixelOk = report.stages.pixels ? report.stages.pixels.pct >= 1.0 : true; // capturePage missing → DOM alone decides
    report.ok = domOk && pixelOk;
    if (!domOk) report.error = `DOM not rendered: rootChildren=${dom.rootChildren} textLength=${dom.textLength}`;
    else if (!pixelOk) report.error = `window frame is flat backdrop (${report.stages.pixels.pct}% non-backdrop)`;
  } catch (err) {
    report.error = err?.message || String(err);
  }

  if (reportPath) {
    try { writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch { /* best effort */ }
  }
  return report;
}
