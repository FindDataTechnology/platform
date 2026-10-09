// Pairing screen — the app's front door. Scan-first (one capture carries the
// instance address AND the code), manual entry as the always-visible fallback
// (camera permission denied, or a code read off another screen). On success
// the token+instance land in the app store and the shell opens.

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";
import { loadOrCreateIdentity } from "@/lib/device-identity";
import { createPairingClient, parsePairingQr } from "@/lib/pairing";
import { secureKeyStore, expoRandom } from "@/lib/rn-secure";
import { useAppStore } from "@/store/app-store";

type PairError = "code" | "network" | "older-server" | "unknown" | null;

export default function PairScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [server, setServer] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairError>(null);
  const connect = useAppStore((s) => s.connect);

  const client = (base: string) =>
    createPairingClient((path, init) =>
      fetch(base.replace(/\/+$/, "") + path, init as RequestInit) as Promise<Response>,
    );

  const submit = async (baseUrl: string, bindCode: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const base = baseUrl.trim().replace(/\/+$/, "");
      const probe = await client(base).probeConfig();
      if (probe === "older-server") {
        setError("older-server");
        return;
      }
      const identity = await loadOrCreateIdentity(secureKeyStore, expoRandom);
      const result = await client(base).pair({
        code: bindCode.trim(),
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        label: `${Platform.OS === "ios" ? "iOS" : "Android"} device`,
      });
      if (!result.ok) {
        setError(result.status === 401 ? "code" : result.status === 503 ? "older-server" : "unknown");
        return;
      }
      connect(base, result.token, result.email);
      router.replace("/");
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  };

  const onScan = async (payload: { data?: string }) => {
    const parsed = parsePairingQr(String(payload?.data ?? ""));
    if (!parsed.code) {
      // Not a pairing QR: say so and keep scanning (no silent failure — the
      // MP login page's contract, carried over).
      return;
    }
    setScanning(false);
    if (parsed.baseUrl) {
      setServer(parsed.baseUrl);
      setCode(parsed.code);
      await submit(parsed.baseUrl, parsed.code);
    } else if (/^\d{6}$/.test(server.slice(0, 0) + parsed.code)) {
      setCode(parsed.code);
    }
  };

  const startScan = async () => {
    if (!permission?.granted) {
      const asked = await requestPermission();
      if (!asked.granted) return; // cameraDenied hint already renders below
    }
    setScanning(true);
  };

  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{t("pair.title")}</Text>
        <Text style={styles.subtitle}>{t("pair.subtitle")}</Text>

        {scanning ? (
          <View style={styles.cameraBox}>
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onScan}
            />
          </View>
        ) : (
          <>
            <Pressable style={styles.scanButton} onPress={() => void startScan()}>
              <Text style={styles.scanButtonText}>{t("pair.scan")}</Text>
            </Pressable>
            <Text style={styles.hint}>
              {permission && permission.granted === false && !permission.canAskAgain
                ? t("pair.cameraDenied")
                : t("pair.scanHint")}
            </Text>

            <Text style={styles.label}>{t("pair.serverLabel")}</Text>
            <TextInput
              style={styles.input}
              testID="server-input"
              value={server}
              onChangeText={setServer}
              placeholder={t("pair.serverPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholderTextColor={palette.muted}
            />
            <Text style={styles.label}>{t("pair.codeLabel")}</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              testID="code-input"
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              placeholder={t("pair.codePlaceholder")}
              keyboardType="number-pad"
              maxLength={6}
              placeholderTextColor={palette.muted}
            />

            {error && <Text style={styles.error}>{t(`pair.err${cap(error)}`)}</Text>}

            <Pressable
              style={[styles.submit, (busy || code.length !== 6 || !server.trim()) && styles.disabled]}
              disabled={busy || code.length !== 6 || !server.trim()}
              onPress={() => void submit(server, code)}
            >
              <Text style={styles.submitText}>{busy ? t("pair.submitting") : t("pair.submit")}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// i18n keys are camelCase after err: errCode / errNetwork / …
function cap(s: string): string {
  const [head, ...rest] = s.split("-");
  return head.toUpperCase() + rest.join("");
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  content: { padding: 24, gap: 10, paddingTop: 72 },
  title: { fontSize: 26, fontWeight: "700", color: palette.ink },
  subtitle: { fontSize: 14, color: palette.muted, lineHeight: 20, marginBottom: 12 },
  scanButton: {
    backgroundColor: palette.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  scanButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  hint: { fontSize: 12, color: palette.muted, lineHeight: 17, marginBottom: 8 },
  label: { fontSize: 13, color: palette.ink, marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: palette.ink,
  },
  codeInput: { letterSpacing: 8, fontSize: 20, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
  error: { color: palette.danger, fontSize: 13, marginTop: 6 },
  submit: {
    backgroundColor: palette.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 14,
  },
  disabled: { opacity: 0.45 },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  cameraBox: { height: 320, borderRadius: 16, overflow: "hidden", backgroundColor: "#000" },
});
