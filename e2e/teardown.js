// Playwright globalTeardown: remove the throwaway store directories created at
// config load time (see e2e/helpers.js).
import { cleanupTempStoreDirs } from "./helpers.js";

export default async function globalTeardown() {
  cleanupTempStoreDirs();
}
