// useTheme: the active theme choice and a setter that persists it.
//
// "system" is represented by the ABSENCE of a stored value and the absence of
// the data-theme attribute — not by the string "system". That is what lets the
// stylesheet's `color-scheme: light dark` resolve the OS preference with no
// JavaScript, which in turn is why the system case cannot flash on first paint.
// Writing "system" into storage would break that.
//
// The pre-paint script in index.html applies a stored choice before the bundle
// runs; this hook owns every change after that. Both use the same key.

import { useCallback, useSyncExternalStore } from "react";

export const THEME_STORAGE_KEY = "platform-theme";

export type Theme = "light" | "dark" | "system";
export const THEMES: readonly Theme[] = ["light", "dark", "system"] as const;

function read(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

// The attribute is the source of truth, so a change made anywhere (this hook,
// the pre-paint script, devtools) reaches every subscriber.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as Theme);

  const setTheme = useCallback((next: Theme) => {
    if (next === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = next;
    }
    try {
      if (next === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable - session-only switch */
    }
  }, []);

  return { theme, themes: THEMES, setTheme };
}
