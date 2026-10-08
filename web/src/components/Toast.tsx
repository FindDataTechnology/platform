// Minimal toast: module-level event bus, one-line API.
import { useEffect, useState } from "react";

const listeners = new Set<(msg: string) => void>();

export function showToast(msg: string) {
  for (const l of listeners) l(msg);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const l = (m: string) => {
      setMsg(m);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 1600);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!msg) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast"
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-card px-4 py-2 text-sm text-foreground shadow-lg"
    >
      {msg}
    </div>
  );
}
