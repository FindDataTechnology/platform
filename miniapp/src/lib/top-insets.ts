// Top chrome metrics for navigationStyle:"custom" (adapt/layout P2 #5):
// the status bar and the capsule (⍶⋯) are device geometry in REAL px — the
// same unit class as the keyboard height, so they must never run through
// pxtransform. Cached once: geometry does not change mid-session.
//
// navHeight reproduces WeChat's own bar math: the capsule's vertical padding
// above+below the status bar, doubled around the capsule height.
// capsuleReserve is the width every header row must keep clear on the right
// so no control ever sits beneath the capsule.

import Taro from "@tarojs/taro";

export interface TopInsets {
  statusBar: number;
  navHeight: number;
  capsuleReserve: number;
}

let cached: TopInsets | null = null;

export function topInsets(): TopInsets {
  if (cached) return cached;
  const info = Taro.getSystemInfoSync();
  const statusBar = info.statusBarHeight || 20;
  let navHeight = 44;
  let capsuleReserve = 96;
  try {
    const rect = Taro.getMenuButtonBoundingClientRect();
    if (rect && rect.top > 0 && rect.height > 0 && info.windowWidth > 0 && rect.left < info.windowWidth) {
      navHeight = Math.max(44, (rect.top - statusBar) * 2 + rect.height);
      capsuleReserve = info.windowWidth - rect.left + 8;
    }
  } catch {
    /* older base libs / partial devtools support: keep the defaults */
  }
  cached = { statusBar, navHeight, capsuleReserve };
  return cached;
}
