// Small tag badge shared by the pack surfaces. Extra props (data-testid,
// title) pass through so callers can anchor tests on a specific badge.

export function Badge({
  children,
  ...rest
}: { children: React.ReactNode } & Omit<React.HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  return (
    <span
      {...rest}
      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
    >
      {children}
    </span>
  );
}
