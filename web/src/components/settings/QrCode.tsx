// QrCode — the binding QR as a presentational component (openspec:
// add-mp-scan-bind). Renders the SVG string from qrSvg() directly, so the
// settings section shows the digits and the code they belong to in the same
// paint. Not wired to any other surface.
//
// SAFETY: the markup is generated locally by src/lib/qr.ts from the bind URL —
// never model output, never user input — which is what makes
// dangerouslySetInnerHTML appropriate here.

import { useMemo } from "react";
import { qrSvg, type QrLevel } from "@/lib/qr";
import { cn } from "@/lib/utils";

export function QrCode({
  text,
  size = 176,
  level = "M",
  testId,
  className,
}: {
  text: string;
  size?: number;
  level?: QrLevel;
  testId?: string;
  className?: string;
}) {
  const svg = useMemo(() => qrSvg(text, { size, level }), [text, size, level]);
  return (
    // The white plate is deliberate: the QR has to stay scannable under the
    // dark theme, where a transparent wrapper would put it on a dark surface.
    <div className={cn("inline-block rounded-md bg-white p-2 [&>svg]:block", className)} data-testid={testId}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: `svg` is generated locally by src/lib/qr.ts from the bind URL — never model output, never user input */}
      <span dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}