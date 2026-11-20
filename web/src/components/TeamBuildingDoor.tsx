// TeamBuildingDoor — the welcome state's build door (add-team-building-first-run).
//
// Why this exists: every deployment already ships the building tools
// (`fleet-architect` / `blueprint-author` / `pack-author` in mcp.json) and the
// `standard` persona now routes to them, but nothing on the first screen said
// so. A newcomer saw four generic prompt cards, none of which led to "make me
// a team". The door is ONE card above the suggested prompts; it never replaces
// or consumes a prompt slot (spec: chat-welcome-state).
//
// Three mutually exclusive intents, because "a standing team" and "a reusable
// expert" are different products and one entry cannot express both:
//   team    → switch to the 团队架构师 pack agent, prefill a team brief
//   expert  → switch to the 智能体作者 pack agent, prefill an expert brief
//   unsure  → ask ≤2 questions, then route to one of the above
//
// Nothing installs, publishes or starts here. If the expert pack is not
// installed in this deployment the door says so and points at the market —
// it never silently falls back to the generic assistant and pretends the
// switch happened.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, ExternalLink, HelpCircle, Users, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useChatStore } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import { cn } from "@/lib/utils";

// The pack agent ids the official Builder packs publish. A deployment without
// those packs has no such roster entry, and the door must say that rather than
// switch to something else.
const TEAM_EXPERT_ID = "fleet-architect";
const EXPERT_EXPERT_ID = "pack-author";

type Choice = "team" | "expert" | "unsure";

interface Props {
  onPrefill: (text: string) => void;
  send: (m: ClientMessage) => void;
}

export function TeamBuildingDoor({ onPrefill, send }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const agents = useChatStore((s) => s.agents);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const [open, setOpen] = useState(false);
  const [clarify, setClarify] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);

  const hasAgent = (id: string) => agents.some((a) => a.id === id);

  // Route to one of the two Builder experts. Honest on every branch: an agent
  // this deployment does not have is named, with the market entry point, and
  // the composer is left untouched.
  const routeTo = (id: string, prefillKey: string) => {
    if (!hasAgent(id)) {
      setMissing(id);
      return;
    }
    setMissing(null);
    if (id !== currentAgent && !isStreaming && !pendingConfig) {
      send({ type: "set_agent", id });
    }
    onPrefill(t(prefillKey));
    setOpen(false);
    setClarify(false);
  };

  const choose = (choice: Choice) => {
    if (choice === "team") return routeTo(TEAM_EXPERT_ID, "chat.welcome.door.prefill.team");
    if (choice === "expert") return routeTo(EXPERT_EXPERT_ID, "chat.welcome.door.prefill.expert");
    setClarify(true);
  };

  const cancel = () => {
    // Zero side effects: nothing was sent, nothing was prefilled, nothing was
    // installed. The welcome state is exactly as it was.
    setOpen(false);
    setClarify(false);
    setMissing(null);
  };

  return (
    <section
      data-testid="chat-welcome-door"
      className="rounded-lg border border-border bg-card p-4"
      aria-labelledby="welcome-door-heading"
    >
      <div className="flex items-start gap-3">
        <Users className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="welcome-door-heading" className="text-sm font-medium text-foreground">
            {t("chat.welcome.door.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("chat.welcome.door.body")}</p>
        </div>
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-testid="chat-welcome-door-open"
            className="ml-auto shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
          >
            {t("chat.welcome.door.open")}
          </button>
        ) : (
          <button
            type="button"
            onClick={cancel}
            data-testid="chat-welcome-door-cancel"
            aria-label={t("chat.welcome.door.cancel")}
            className="ml-auto shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {open && !clarify && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="chat-welcome-door-choices">
          <ChoiceButton
            icon={<Users className="h-4 w-4" aria-hidden="true" />}
            title={t("chat.welcome.door.team.title")}
            body={t("chat.welcome.door.team.body")}
            onClick={() => choose("team")}
            testId="chat-welcome-door-team"
          />
          <ChoiceButton
            icon={<Bot className="h-4 w-4" aria-hidden="true" />}
            title={t("chat.welcome.door.expert.title")}
            body={t("chat.welcome.door.expert.body")}
            onClick={() => choose("expert")}
            testId="chat-welcome-door-expert"
          />
          <ChoiceButton
            icon={<HelpCircle className="h-4 w-4" aria-hidden="true" />}
            title={t("chat.welcome.door.unsure.title")}
            body={t("chat.welcome.door.unsure.body")}
            onClick={() => choose("unsure")}
            testId="chat-welcome-door-unsure"
          />
        </div>
      )}

      {open && clarify && (
        <div className="mt-3 flex flex-col gap-2" data-testid="chat-welcome-door-clarify">
          <p className="text-xs text-muted-foreground">{t("chat.welcome.door.clarify.intro")}</p>
          <ChoiceButton
            icon={<Users className="h-4 w-4" aria-hidden="true" />}
            title={t("chat.welcome.door.clarify.keepRunning")}
            body={t("chat.welcome.door.clarify.keepRunningBody")}
            onClick={() => routeTo(TEAM_EXPERT_ID, "chat.welcome.door.prefill.team")}
            testId="chat-welcome-door-clarify-team"
          />
          <ChoiceButton
            icon={<Bot className="h-4 w-4" aria-hidden="true" />}
            title={t("chat.welcome.door.clarify.oneOff")}
            body={t("chat.welcome.door.clarify.oneOffBody")}
            onClick={() => routeTo(EXPERT_EXPERT_ID, "chat.welcome.door.prefill.expert")}
            testId="chat-welcome-door-clarify-expert"
          />
        </div>
      )}

      {missing && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="chat-welcome-door-missing">
          <p className="text-xs text-muted-foreground">
            {t("chat.welcome.door.missing", {
              name: t(
                missing === TEAM_EXPERT_ID
                  ? "chat.welcome.door.team.expertName"
                  : "chat.welcome.door.expert.expertName",
              ),
            })}
          </p>
          <button
            type="button"
            onClick={() => navigate("/agents")}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            data-testid="chat-welcome-door-market"
          >
            {t("chat.welcome.door.gotoMarket")}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

function ChoiceButton({
  icon,
  title,
  body,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex items-start gap-2 rounded-md border border-border bg-background p-3 text-left transition-colors",
        "hover:border-primary/40 hover:bg-muted/50",
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground">{body}</span>
      </span>
    </button>
  );
}
