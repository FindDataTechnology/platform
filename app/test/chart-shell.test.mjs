// Chart shell contract tests (task 4.2): the WebView shell and the RN host
// agree on three messages — 'ready' (shell mounted), 'ok' (setOption ran),
// 'fail' (any render error). The settle handshake is what keeps a healthy
// chart from being flipped to the code-block fallback by the 4s degrade
// timer (the v1 bug this test pins against regressing).

import test from "node:test";
import assert from "node:assert/strict";
import { chartShellHtml } from "../src/lib/chart-shell.ts";

// The shell now inlines the vendored echarts source; the contract is checked on
// the HTML with a placeholder, so the 1MB payload stays out of the test.
const CHART_SHELL = chartShellHtml("/chart-assets/echarts.min.js");

test("shell posts 'ready' once mounted", () => {
  assert.match(CHART_SHELL, /DOMContentLoaded.*postMessage\('ready'\)/s);
});

test("shell posts 'ok' only after a successful setOption", () => {
  assert.ok(CHART_SHELL.indexOf("setOption(option)") < CHART_SHELL.indexOf("postMessage('ok')"));
});

test("shell posts 'fail' on guard refusal and on render throw", () => {
  // both the __fail/!echarts guard and the catch branch must report
  assert.equal(CHART_SHELL.match(/postMessage\('fail'\)/g).length, 2);
});

test("shell loads echarts from the paired platform, never a CDN", () => {
  const html = chartShellHtml("/chart-assets/echarts.min.js");
  assert.match(html, /<script src="\/chart-assets\/echarts\.min\.js"/);
  assert.ok(!/cdn\.jsdelivr\.net/.test(html), "no CDN script tag remains");
});

test("render path is guarded against a failed script load (window.__fail)", () => {
  assert.match(CHART_SHELL, /window\.__fail \|\| !window\.echarts/);
});
