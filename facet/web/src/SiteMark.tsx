// Text-character site marks (facet-platform spec: "Site marks are text
// characters sized by placement"). The header carries the line's single
// character; the footer brand block and the ladder rows carry the
// two-character mark. Rendered from text — no image asset ships for the
// marks. The seal red and the serif stack match 识律's SealMark so the family
// marks read as one set.
const SEAL_RED = "#A6402F";
const SEAL_SERIF = "'Noto Serif SC', 'Songti SC', 'SimSun', serif";

type Size = "sm" | "md" | "lg";

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-7 w-7 text-[10px]", // ladder rows
  md: "h-8 w-8 text-[12px]", // header mark
  lg: "h-11 w-11 text-[14px]", // footer brand block
};

export function SiteMark({
  chars,
  size = "md",
  variant = "seal",
  className = "",
}: {
  chars: string;
  size?: Size;
  variant?: "seal" | "outline";
  className?: string;
}) {
  const two = Array.from(chars).length > 1;
  return (
    <span
      role="img"
      aria-label={chars}
      className={[
        "inline-flex shrink-0 select-none items-center justify-center rounded-[5px] font-semibold",
        two ? "flex-col leading-[1.02]" : "leading-none",
        SIZE_CLASS[size],
        variant === "seal" ? "text-white" : "border border-border text-muted-foreground",
        className,
      ].join(" ")}
      style={{
        fontFamily: SEAL_SERIF,
        background: variant === "seal" ? SEAL_RED : "transparent",
      }}
    >
      {Array.from(chars).map((ch, i) => (
        /* biome-ignore lint/suspicious/noArrayIndexKey: a static text mark — the characters never reorder, the index is the identity */
        <span key={i}>{ch}</span>
      ))}
    </span>
  );
}