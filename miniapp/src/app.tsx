import type { PropsWithChildren } from "react";
import { useEffect } from "react";
import { useDidShow } from "@tarojs/taro";
import { runtime } from "@/lib/runtime";
import "./app.css";

export default function App({ children }: PropsWithChildren) {
  useEffect(() => {
    void runtime.boot();
  }, []);

  // Backgrounding kills mini-program sockets; re-establish on foreground.
  useDidShow(() => {
    runtime.onForeground();
  });

  return children;
}
