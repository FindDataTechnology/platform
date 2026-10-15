// useOverlayStore — the focus overlay's WS pulse (add-focus-overlay).
//
// `overlay_changed` is deployment-global: any client's PUT shifts every
// client's view. The store carries no overlay data itself (the GET is the
// single source); it only pulses so an open 资源微调 panel knows to refetch.

import { create } from "zustand";
import type { ServerMessage } from "@platform/core";

interface OverlayState {
  pulse: number;
  lastPreset: string | null;
  applyEvent: (msg: ServerMessage) => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  pulse: 0,
  lastPreset: null,
  applyEvent: (msg) => {
    if (msg.type !== "overlay_changed") return;
    set((s) => ({ pulse: s.pulse + 1, lastPreset: msg.preset }));
  },
}));
