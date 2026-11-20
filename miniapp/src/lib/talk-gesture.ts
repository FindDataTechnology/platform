// talk-gesture — the mini-program's hold-to-talk gesture rule (openspec:
// add-voice-input-mobile, task 2.3).
//
// Mobile uses press-and-hold (the muscle memory), web used click-to-start /
// click-to-stop. The *transitions* must be identical across clients, so only
// this thin gesture layer differs — and it is pure, so the four gestures can be
// asserted in node instead of on a device:
//
//   begin → end            ⇒ start, stop
//   begin → move up → end  ⇒ start, cancel   (and NO stop: cancel leaves nothing)
//   begin → move up → back down → end ⇒ start, cancel  (cancel is one-way)
//   begin → move a little  ⇒ still stop (below the threshold it is not a cancel)
//
// The cancelled flag is deliberately sticky: once the user has slid into the
// cancel zone the take is gone, and sliding back must not resurrect a take they
// already abandoned.

export interface TalkGestureHandlers {
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}

export interface TalkGestureOptions {
  /** Vertical distance (px) the finger must travel up to cancel. */
  slideUpPx?: number;
}

export interface TalkGesture {
  begin(y: number): void;
  move(y: number): void;
  end(): void;
  /** Programmatic cancel (page hidden, keyboard, unmount). */
  cancel(): void;
  isCancelling(): boolean;
  isActive(): boolean;
}

export function createTalkGesture(handlers: TalkGestureHandlers, options: TalkGestureOptions = {}): TalkGesture {
  const threshold = options.slideUpPx ?? 60;
  let startY: number | null = null;
  let active = false;
  let cancelling = false;

  return {
    begin(y: number) {
      if (active) return; // a second finger must not restart the take
      active = true;
      cancelling = false;
      startY = y;
      handlers.onStart();
    },

    move(y: number) {
      if (!active || cancelling || startY === null) return;
      // Sliding up (smaller y) past the threshold arms the cancel.
      if (startY - y >= threshold) {
        cancelling = true;
        handlers.onCancel();
      }
    },

    end() {
      if (!active) return;
      const wasCancelling = cancelling;
      active = false;
      cancelling = false;
      startY = null;
      // A cancelled take is over: stop() would ask the recorder for an artifact
      // we already decided to throw away.
      if (!wasCancelling) handlers.onStop();
    },

    cancel() {
      if (!active) return;
      const already = cancelling;
      active = false;
      startY = null;
      cancelling = false;
      if (!already) handlers.onCancel();
    },

    isCancelling: () => cancelling,
    isActive: () => active,
  };
}
