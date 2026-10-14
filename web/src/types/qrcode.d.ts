// `qrcode` ships no type declarations, and only its browser-safe SVG path is
// used here (see src/lib/qr.ts): the core encoder and the svg-tag renderer.
// The shapes below are the subset those two functions actually consume and
// return — enough to type the call sites, not a transcription of the package.

declare module "qrcode/lib/core/qrcode.js" {
  export interface QrCodeData {
    modules: { size: number; data: Uint8Array };
  }

  export function create(
    text: string,
    options?: {
      errorCorrectionLevel?: "L" | "M" | "Q" | "H";
      version?: number;
      maskPattern?: number;
    },
  ): QrCodeData;
}

declare module "qrcode/lib/renderer/svg-tag.js" {
  import type { QrCodeData } from "qrcode/lib/core/qrcode.js";

  export function render(
    qrData: QrCodeData,
    options?: {
      width?: number;
      margin?: number;
      color?: { dark?: string; light?: string };
    },
  ): string;
}