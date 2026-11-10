// Non-secret app state, persisted with zustand: the connected instance, the
// current platform token, and the locale choice. The Ed25519 private key and
// deviceId live in SecureStore (device-identity), NOT here — this store holds
// only what a fresh launch needs before the silent exchange re-mints a token.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type Locale = "zh-CN" | "en";

interface AppState {
  baseUrl: string | null;
  token: string | null;
  email: string | null;
  locale: Locale | null;
  // The chat error sink's landing field (core's setChatErrorSink) — the chat
  // page renders and clears it.
  lastChatError: string | null;
  connect: (baseUrl: string, token: string, email: string) => void;
  setToken: (token: string) => void;
  setLocale: (locale: Locale) => void;
  clearChatError: () => void;
  disconnect: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      baseUrl: null,
      token: null,
      email: null,
      locale: null,
      lastChatError: null,
      connect: (baseUrl, token, email) => set({ baseUrl, token, email }),
      setToken: (token) => set({ token }),
      setLocale: (locale) => set({ locale }),
      clearChatError: () => set({ lastChatError: null }),
      disconnect: () => set({ baseUrl: null, token: null, email: null, lastChatError: null }),
    }),
    { name: "yizuo.app", storage: createJSONStorage(() => AsyncStorage), partialize: (s) => ({ baseUrl: s.baseUrl, token: s.token, email: s.email, locale: s.locale }) },
  ),
);
