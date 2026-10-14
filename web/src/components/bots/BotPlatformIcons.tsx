// BotPlatformIcons — small self-authored brand marks for the four supported
// chat platforms. Lucide has no brand set, and no icon dependency is added
// (design D1), so these are simplified in-repo approximations: recognizable
// silhouette + platform color, not pixel-perfect logos.

type Props = { className?: string };

export function TelegramIcon({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#229ED9" />
      <path
        d="M5.7 11.6 17.6 7c.6-.24 1.16.2.95 1l-1.95 9.1c-.14.66-.6.82-1.2.5l-3.3-2.4-1.6 1.55c-.2.2-.36.3-.7.3l.25-3.4 6.1-5.5c.27-.24-.06-.36-.4-.13l-7.6 4.75-3.3-1c-.73-.24-.74-.72.15-1.07Z"
        fill="#fff"
      />
    </svg>
  );
}

export function FeishuIcon({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M4.5 9.4c2.3 1 4.3.5 5.9-1.1l2-2.1c1.7-1.7 4.3-2 6.2-.7l-4.5 5.1c-2.3 2.7-6 3.2-9.6 1.4V9.4Z"
        fill="#00D6B9"
      />
      <path
        d="M19.5 14.6c-2.3-1-4.3-.5-5.9 1.1l-2 2.1c-1.7 1.7-4.3 2-6.2.7l4.5-5.1c2.3-2.7 6-3.2 9.6-1.4v2.6Z"
        fill="#3370FF"
      />
    </svg>
  );
}

export function WecomIcon({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" fill="#0082EF" />
      <path
        d="M12 6.6c-3.3 0-6 2.1-6 4.7 0 1.5.9 2.9 2.3 3.7l-.6 2 2.3-1.2c.6.2 1.3.3 2 .3 3.3 0 6-2.1 6-4.8s-2.7-4.7-6-4.7Z"
        fill="#fff"
      />
    </svg>
  );
}

export function WechatOaIcon({ className }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 4.2c-4.7 0-8.5 3-8.5 6.8 0 2.2 1.2 4.1 3 5.3l-.8 2.5 3-1.5c1 .3 2.1.5 3.3.5 4.7 0 8.5-3 8.5-6.8S16.7 4.2 12 4.2Z"
        fill="#07C160"
      />
      <circle cx="9.2" cy="10.6" r="1.15" fill="#fff" />
      <circle cx="14.8" cy="10.6" r="1.15" fill="#fff" />
    </svg>
  );
}

const ICONS = {
  telegram: TelegramIcon,
  feishu: FeishuIcon,
  wecom: WecomIcon,
  "wechat-oa": WechatOaIcon,
} as const;

// The one component the page uses; an unknown type falls back to a neutral dot.
export function BotPlatformIcon({ type, className }: Props & { type: string }) {
  const Icon = ICONS[type as keyof typeof ICONS];
  return Icon ? (
    <Icon className={className} />
  ) : (
    <span className={`inline-block h-2 w-2 rounded-full bg-muted-foreground ${className ?? ""}`} />
  );
}
