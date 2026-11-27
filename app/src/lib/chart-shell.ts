// Chart WebView shell (task 4.2): the HTML an echarts option is posted into.
// Contract with the RN host (ChartView.tsx):
//   posts 'ready' once the shell can receive options (DOMContentLoaded),
//   posts 'ok'   after a successful echarts.setOption,
//   posts 'fail' on any render error (and stops trusting itself via __fail).
// echarts is served BY THE PLATFORM the app is paired to
// (`/chart-assets/echarts.min.js`, resources/chart-assets), not a CDN. Two
// findings forced this: the acceptance emulator's WebView is Chrome 83
// (echarts 6 fails to parse there, 2026-10-27) and its outbound network is
// unreliable (CDN fetch failed → every chart degraded to the fallback state,
// 2026-10-28). Inlining the 1MB bundle instead crashed the emulator's WebView
// renderer process (2026-10-28) — same-origin hosting is the one path that is
// offline-safe, bundle-free and cheap for the WebView.

export function chartShellHtml(echartsUrl: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}</style></head><body><div id="c" style="width:100vw;height:100vh"></div>
<script>
function __dbg(m){ try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('dbg:'+m); } catch(e){} }
__dbg('shell-start url=${echartsUrl}');
</script>
<script src="${echartsUrl}" onerror="__dbg('script-load-error')"></script>
<script>
__dbg('echarts-typeof=' + (typeof window.echarts));
// RN-to-JS messages arrive on the DOCUMENT on Android and on window on iOS —
// listening on window alone made the option post invisible to the render
// path on every Android device (the chart acceptance lane's final bug).
function __onHostMessage(e){ try { render(JSON.parse(e.data)); } catch(err){ window.__fail=1; } }
document.addEventListener('message', __onHostMessage);
window.addEventListener('message', __onHostMessage);
function render(option){
  if (window.__fail || !window.echarts) { document.title='fail'; __dbg('render-fail __fail=' + window.__fail + ' echarts=' + (typeof window.echarts)); if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('fail'); return; }
  try {
    var chart = echarts.init(document.getElementById('c'));
    chart.setOption(option);
    document.title='ok';
    __dbg('render-ok');
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ok');
  } catch (err) {
    document.title='fail';
    __dbg('render-throw ' + (err && err.message));
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('fail');
  }
}
window.__chartShellReady = false;
document.addEventListener('DOMContentLoaded', function(){
  window.__chartShellReady = true;
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ready');
});
</script></body></html>`;
}
