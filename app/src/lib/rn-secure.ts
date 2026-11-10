// expo-secure-store / expo-crypto bound to the identity interfaces. The pure
// logic (device-identity.ts) stays injectable for node tests; this file is the
// RN binding only.

import * as SecureStore from "expo-secure-store";
import * as ExpoCrypto from "expo-crypto";
import type { KeyStore, RandomProvider } from "./device-identity";

export const secureKeyStore: KeyStore = {
  async get(key) {
    return SecureStore.getItemAsync(key);
  },
  async set(key, value) {
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key) {
    await SecureStore.deleteItemAsync(key);
  },
};

export const expoRandom: RandomProvider = (n) => ExpoCrypto.getRandomBytes(n);
