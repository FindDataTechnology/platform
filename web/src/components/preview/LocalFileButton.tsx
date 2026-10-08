// The local-file affordance for the preview drawer.
//
// Rendered in both chat states: an empty chat is exactly where "just let me look
// at this file" happens, so the picker cannot live only in the in-session header.
// The chosen file is rendered from a blob object URL — no request carries its
// bytes, and the preview store revokes the URL when the drawer closes.

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Eye } from "lucide-react";
import { usePreviewStore } from "@/hooks/usePreviewStore";

export function LocalFileButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const open = usePreviewStore((s) => s.open);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        data-testid="preview-local-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            open({ name: file.name, url: URL.createObjectURL(file), objectUrl: true });
          }
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        data-testid="preview-local-open"
        aria-label={t("preview.openLocal")}
        title={t("preview.openLocal")}
        className={className}
      >
        <Eye className="h-4 w-4" aria-hidden="true" />
      </button>
    </>
  );
}
