// ChatWelcome — the empty-state surface for the chat page.
//
// Rendered when `turns.length === 0` (mutually exclusive with `<Chat /> +
// <ChatHeader /> + <Composer />`). Greets the user, surfaces 4 suggested prompt
// cards, lists recent sessions (expandable), and shows the active model/agent
// as a subtle footer.
//
// The four cards FOLLOW the selected expert (add-onboarding-tutorial): a pack
// expert with prompt content in the client module shows that pack's domain
// prompts; a custom preset or focused role without pack content shows the
// focused-mode generic set (i18n); everything else keeps the default general
// set. Clicking a card PREFILLS the composer instead of sending — unchanged
// for every set (spec: chat-welcome-state).

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Database, Sparkles, Search, PenLine, Wand2, type LucideIcon } from "lucide-react";
import { useChatStore } from "@platform/core";
import { AssistantPicker } from "@/components/AssistantPicker";
import { IntentOnboarding } from "@/components/IntentOnboarding";
import { LocalFileButton } from "@/components/preview/LocalFileButton";
import { promptsFor } from "@/lib/packGuides";
import type { ClientMessage } from "@platform/core";

// Default set — stable identity: key → i18n key pair + icon. The prompt text
// lives in the locale bundles so zh-CN lands first and the other four locales
// follow. Each exercises something only this product does (documents RAG,
// skills, tool-assisted lookup, daily writing).
const DEFAULT_PROMPTS: { key: string; icon: LucideIcon }[] = [
  { key: "docs", icon: Database },
  { key: "skills", icon: Sparkles },
  { key: "tools", icon: Search },
  { key: "write", icon: PenLine },
];

const FOCUSED_ICONS: LucideIcon[] = [Wand2, Sparkles, PenLine, Database];

interface PromptCard {
  key: string;
  icon: LucideIcon;
  title: string;
  text: string;
}

const RECENT_PREVIEW = 5;

interface Props {
  // Prefill the composer with a suggested prompt (ChatPage owns the draft so
  // it survives the welcome → in-session branch swap).
  onPrefill: (text: string) => void;
  // Recent-row navigation still needs the WS `send`.
  send: (m: ClientMessage) => void;
}

export function ChatWelcome({ onPrefill, send }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sessions = useChatStore((s) => s.sessions);
  const currentModel = useChatStore((s) => s.currentModel);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const agents = useChatStore((s) => s.agents);
  const [showAllRecent, setShowAllRecent] = useState(false);

  // Most-recently-updated first. updatedAt is string | number (legacy stores
  // used epoch ms); coerce to a string for the comparison.
  const sorted = useMemo(
    () =>
      sessions
        .slice()
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    [sessions],
  );
  const recent = showAllRecent ? sorted : sorted.slice(0, RECENT_PREVIEW);

  const agentName = useMemo(() => {
    if (!currentAgent || currentAgent === "local") return null;
    return agents.find((a) => a.id === currentAgent)?.name || currentAgent;
  }, [currentAgent, agents]);

  // Prompt-set dispatch (spec: chat-welcome-state). Pack prompts come from
  // the client content module (zh content); the focused set is i18n chrome.
  const cards = useMemo<PromptCard[]>(() => {
    const info = currentAgent ? agents.find((a) => a.id === currentAgent) : undefined;
    const packPrompts = promptsFor(info?.packId);
    if (packPrompts) {
      return packPrompts.map((p, i) => ({ key: `pack-${i}`, icon: FOCUSED_ICONS[i % FOCUSED_ICONS.length] ?? Wand2, ...p }));
    }
    if (info?.customPreset || info?.packId) {
      return FOCUSED_ICONS.map((icon, i) => ({
        key: `focused-${i + 1}`,
        icon,
        title: t(`chat.welcome.promptsFocused.${i + 1}.title`),
        text: t(`chat.welcome.promptsFocused.${i + 1}.text`),
      }));
    }
    return DEFAULT_PROMPTS.map(({ key, icon }) => ({
      key,
      icon,
      title: t(`chat.welcome.prompts.${key}.title`),
      text: t(`chat.welcome.prompts.${key}.text`),
    }));
  }, [agents, currentAgent, t]);

  return (
    <div
      data-testid="chat-welcome"
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-10"
    >
      {/* my-auto, not justify-center: an overflowing flex-centered child splits
          the overflow above AND below, and scrollTop cannot go negative — the
          top of the content becomes permanently unreachable (the copilot
          dock's short iframe hid the greeting's first row). Margin auto
          centers only while the content fits and collapses to top-aligned
          (fully scrollable) when it does not. */}
      <div className="mx-auto my-auto flex w-full max-w-4xl flex-col gap-8">
        {/* Greeting */}
        <h1 className="text-2xl font-semibold text-foreground">
          {t("chat.welcome.greeting")}
        </h1>

        {/* Intent questionnaire (intent-onboarding): renders only for a user
            whose profile is empty and unskipped — the server decides. The
            composer below stays usable throughout. */}
        <IntentOnboarding />

        {/* The unified assistant picker (simplify-chat-and-agents-ia): who
            this conversation runs with — standard, pack roles, clusters, and
            the user's own experts in one selector. Nothing to choose renders
            nothing. */}
        <AssistantPicker send={send} variant="welcome" />

        {/* Suggested prompts */}
        <section aria-labelledby="welcome-prompts-heading" className="flex flex-col gap-3">
          <h2 id="welcome-prompts-heading" className="text-sm font-medium text-muted-foreground">
            {t("chat.welcome.suggestedPrompts")}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cards.map(({ key, icon: Icon, title, text }) => {
              return (
                <button
                  key={key}
                  type="button"
                  data-testid="welcome-prompt-card"
                  data-prompt-key={key}
                  onClick={() => onPrefill(text)}
                  className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/50"
                >
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium text-foreground">{title}</span>
                    {/* Preview collapses the multi-line starter template to its
                        first sentence — the prefill keeps the full text. */}
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {text.replace(/\s*\n+\s*/g, " ")}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Recent chats — hidden when empty */}
        {sorted.length > 0 && (
          <section aria-labelledby="welcome-recent-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 id="welcome-recent-heading" className="text-sm font-medium text-muted-foreground">
                {t("chat.welcome.recentChats")}
              </h2>
              {sorted.length > RECENT_PREVIEW && (
                <button
                  type="button"
                  data-testid="welcome-view-all"
                  onClick={() => setShowAllRecent((v) => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {showAllRecent ? t("chat.welcome.viewLess") : t("chat.welcome.viewAll")}
                </button>
              )}
            </div>
            <ul className="flex flex-col gap-1">
              {recent.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    data-testid="welcome-recent-row"
                    data-session-id={s.id}
                    onClick={() => send({ type: "switch_session", id: s.id })}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="truncate text-foreground">{s.title}</span>
                    {s.updatedAt && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(s.updatedAt).toLocaleString()}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Footer: model + agent */}
        <footer className="flex items-center gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
          {/* Preview a file without starting a conversation — the welcome state
              is where "just show me this file" most often lands. */}
          <LocalFileButton className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground" />
          {currentModel && (
            <button
              type="button"
              data-testid="welcome-model-footer"
              onClick={() => navigate("/models")}
              className="rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
            >
              {t("chat.welcome.modelFooter", { model: currentModel })}
            </button>
          )}
          {agentName && (
            <button
              type="button"
              data-testid="welcome-agent-footer"
              onClick={() => navigate("/agents")}
              className="rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
            >
              {t("chat.welcome.agentFooter", { agent: agentName })}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
