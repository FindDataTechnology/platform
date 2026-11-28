// Chart rendering (design D5): a controlled WebView hosting echarts, fed the
// option JSON over postMessage. Failure contract = the other clients':
// timeout or an echarts error degrades to the raw code block. v1 loads
// echarts from a CDN — charts only exist for data a reachable server sent —
// with a vendored offline copy as the v1.x hardening path.

import { useEffect, useMemo, useRef, useState } from "react";
import { WebView } from "react-native-webview";
import { Text, View, StyleSheet } from "react-native";
import { palette } from "./palette";
import { chartShellHtml } from "@/lib/chart-shell";
import { useAppStore } from "@/store/app-store";

export function ChartView({ option, height = 220 }: { option: unknown; height?: number }) {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Render outcome, exposed as native testIDs (chart-loading|ok|fallback) so
  // device lanes can assert "the chart rendered, the fallback never showed"
  // without reaching inside the WebView (automate-nonweb-acceptance 1.3).
  const [ok, setOk] = useState(false);
  // Settled by the shell's postMessage('ok'|'fail') after setOption; without
  // it the 4s degrade timer flipped every healthy chart to the fallback.
  const settled = useRef(false);
  // echarts rides the platform we are already paired to (same origin, offline).
  const baseUrl = useAppStore((s) => s.baseUrl);
  const shell = useMemo(() => chartShellHtml(`${String(baseUrl ?? "").replace(/\/+$/, "")}/chart-assets/echarts.min.js`), [baseUrl]);

  useEffect(() => {
    if (!ready || failed) return;
    settled.current = false;
    setOk(false);
    webRef.current?.postMessage(JSON.stringify(option));
    // The degrade contract: no confirmation within 4s = treat as failure.
    const t = setTimeout(() => {
      if (!settled.current) setFailed(true);
    }, 4000);
    return () => clearTimeout(t);
  }, [ready, option, failed]);

  if (failed) {
    return (
      <View testID="chart-fallback" style={[styles.fallback, { height }]}>
        <Text style={styles.fallbackText} selectable>
          {JSON.stringify(option, null, 1).slice(0, 600)}
        </Text>
      </View>
    );
  }

  return (
    <View
      testID={ok ? "chart-ok" : "chart-loading"}
      style={{ height, borderRadius: 12, overflow: "hidden", backgroundColor: palette.card, borderWidth: 1, borderColor: palette.line }}
    >
      <WebView
        ref={webRef}
        source={{ html: shell }}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={(e) => {
          const data = String(e.nativeEvent.data);
          if (data === "ready") setReady(true);
          if (data === "ok") {
            settled.current = true;
            setOk(true);
          }
          if (data.includes("fail")) {
            settled.current = true;
            setFailed(true);
          }
        }}
        onError={() => setFailed(true)}
        // The shell's DOMContentLoaded 'ready' postMessage races the native
        // onMessage binding on Android (early messages are silently dropped —
        // the whole chart went dark because of it). onLoadEnd re-arms the
        // handshake: inject a check and re-post if the shell is ready but the
        // host never saw it.
        onLoadEnd={() => {
          webRef.current?.injectJavaScript(
            "if (window.__chartShellReady && !window.__chartReadySent) { window.__chartReadySent = true; window.ReactNativeWebView.postMessage('ready'); } true;",
          );
        }}
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: palette.codeBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.line,
    padding: 10,
    justifyContent: "center",
  },
  fallbackText: { fontSize: 11, fontFamily: "Menlo", color: palette.muted, lineHeight: 15 },
});
