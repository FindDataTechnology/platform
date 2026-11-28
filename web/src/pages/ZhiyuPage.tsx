// ZhiyuPage.tsx — 萬星·智语: rooms list + pending invites + room creation
// (add-zhiyu-room group 9).
//
// Reads are server-owned like every other surface: the page re-fetches the
// list after each write instead of caching. The dual inbox below the rooms is
// where an invitation handshake is answered — invitations are ACTIONABLE rows
// (accept/decline), notifications are ambient (invite/call/minutes feed).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/ui/page-shell";
import { StatusPill } from "@/components/ui/status-pill";
import { EmptyState, ErrorState } from "@/components/ui/states-kit";
import { TeamAccountsCard } from "@/components/zhiyu/TeamAccountsCard";
import type { StatusKind } from "@/lib/statusTokens"

interface RoomRow {
  id: string;
  title: string;
  ownerEmail: string;
  status: "active" | "ended";
  effectiveReplyCap: number;
  lastActivityAt: number;
  createdAt: number;
}

interface InviteRow {
  id: string;
  roomId: string;
  kind: "user" | "facade" | "agent";
  display: string;
  invitedBy: string;
  historyGrant: "join_from" | "full";
  room: { id: string; title: string } | null;
}

interface NoticeRow {
  id: string;
  type: string;
  roomId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

async function jcall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}

export function ZhiyuPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [replyCap, setReplyCap] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  // Ended rooms are history: grouped under a collapsed header so they never
  // compete with the rooms that still take turns.
  const [endedOpen, setEndedOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [r, i, n] = await Promise.all([
        jcall<{ rooms: RoomRow[] }>("GET", "/api/zhiyu/rooms"),
        jcall<{ invites: InviteRow[] }>("GET", "/api/zhiyu/invites"),
        jcall<{ notifications: NoticeRow[]; unread: number }>("GET", "/api/zhiyu/notifications"),
      ]);
      setRooms(r.rooms);
      setInvites(i.invites);
      // Show every notification type (invites included) so the panel's row set
      // matches the unread count exactly — a badge can never point at nothing
      // (openspec: polish-web-surfaces, zhiyu-room 通知与触达).
      setNotices(n.notifications.slice(0, 20));
      setEnabled(true);
      setError(null);
    } catch (err) {
      setEnabled(false);
      setError((err as Error).message);
    }
  }, []);

  // Viewing this page clears the user's unread lane (openspec:
  // polish-web-surfaces, zhiyu-room 通知与触达), and the fresh count is broadcast
  // so the nav badge clears at once — not on the sidebar's next 60s poll.
  //
  // ORDER IS THE FEATURE (measured 2026-11-14, e2e zhiyu-unread-badge:21 red in
  // three full runs, green standalone with 5.5s to spare): these used to be two
  // independent mount effects, so the read-all POST could land BEFORE the list
  // GET. A read-all marks the lane read, so the GET that followed answered with
  // no notifications and the page rendered empty — you open 知遇 to read the
  // notices and they are already gone. Fetch first, mark read after; the badge
  // still clears in the same tick as before because the broadcast follows.
  useEffect(() => {
    let alive = true;
    void (async () => {
      await refresh();
      if (!alive) return;
      try {
        const out = await jcall<{ unread: number }>("POST", "/api/zhiyu/notifications/read-all");
        if (alive) {
          window.dispatchEvent(new CustomEvent("zhiyu:unread", { detail: { unread: out.unread } }));
        }
      } catch {
        /* unreachable server: the badge simply stays until the next poll */
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const create = async () => {
    setBusy(true);
    try {
      const out = await jcall<{ room: RoomRow }>("POST", "/api/zhiyu/rooms", {
        title: title.trim(),
        ...(replyCap.trim() ? { replyCap: Number(replyCap) } : {}),
        ...(budget.trim() ? { dailyBudgetTurns: Number(budget) } : {}),
      });
      setCreateOpen(false);
      setTitle("");
      setReplyCap("");
      setBudget("");
      navigate(`/zhiyu/${out.room.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const answerInvite = async (invite: InviteRow, verdict: "accept" | "decline") => {
    try {
      await jcall("POST", `/api/zhiyu/invites/${invite.id}/${verdict}`);
      if (verdict === "accept") navigate(`/zhiyu/${invite.roomId}`);
      else void refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (enabled === false) {
    // Even the unavailable state keeps the surface's title — the page must
    // always announce where you are before it explains what failed.
    return (
      <PageShell data-testid="zhiyu-page" title={t("zhiyu.title")} bodyClassName="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-center py-16">
          <ErrorState
            message={t("zhiyu.unavailable", { error: error ?? "" })}
            onRetry={() => void refresh()}
            retryLabel={t("common.retry")}
          />
        </div>
      </PageShell>
    );
  }

  // Room state → the four-word vocabulary; the label always rides along.
  const roomStatus = (s: RoomRow["status"]): StatusKind => (s === "active" ? "running" : "paused")

  // Ongoing rooms first; ended ones collapse into their own group below.
  const activeRooms = rooms.filter((r) => r.status === "active");
  const endedRooms = rooms.filter((r) => r.status === "ended");

  const roomRow = (room: RoomRow) => (
    <button
      type="button"
      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => navigate(`/zhiyu/${room.id}`)}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{room.title || room.id}</span>
        <span className="block text-xs text-muted-foreground">
          {t("zhiyu.rooms.meta", {
            status: t(`zhiyu.status.${room.status}`),
            cap: room.effectiveReplyCap,
            at: new Date(room.lastActivityAt).toLocaleString(),
          })}
        </span>
      </span>
      <StatusPill
        status={roomStatus(room.status)}
        label={t(`zhiyu.status.${room.status}`)}
        className="shrink-0"
      />
    </button>
  );

  return (
    <PageShell
      data-testid="zhiyu-page"
      title={t("zhiyu.title")}
      actions={
        <Button onClick={() => setCreateOpen(true)} data-testid="zhiyu-create-open">
          {t("zhiyu.createRoom")}
        </Button>
      }
      bodyClassName="mx-auto w-full max-w-3xl"
    >
      <div className="space-y-4 pb-4">
        {error && (
          <div className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-sm text-status-failed">{error}</div>
        )}

        {invites.length > 0 && (
          <Card data-testid="zhiyu-invites" title={t("zhiyu.invites.title")}>
            <ul className="space-y-2">
              {invites.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    <b>{inv.display}</b> · {inv.room?.title ?? inv.roomId} · {t(`zhiyu.kind.${inv.kind}`)} ·{" "}
                    {t("zhiyu.invites.from", { by: inv.invitedBy })}
                  </span>
                  <span className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => void answerInvite(inv, "accept")}>
                      {t("zhiyu.invites.accept")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void answerInvite(inv, "decline")}>
                      {t("zhiyu.invites.decline")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card data-testid="zhiyu-rooms" className="p-0">
          {rooms.length === 0 ? (
            <EmptyState className="m-4 border-0 bg-transparent" title={t("zhiyu.rooms.empty")} />
          ) : (
            <>
              <ul className="divide-y divide-border">
                {activeRooms.map((room) => (
                  <li key={room.id}>{roomRow(room)}</li>
                ))}
              </ul>
              {endedRooms.length > 0 ? (
                <div className="border-t border-border" data-testid="zhiyu-ended-group">
                  <button
                    type="button"
                    onClick={() => setEndedOpen((v) => !v)}
                    aria-expanded={endedOpen}
                    data-testid="zhiyu-ended-toggle"
                    className="flex w-full items-center gap-1 px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${endedOpen ? "" : "-rotate-90"}`} aria-hidden="true" />
                    {t("zhiyu.rooms.ended", { count: endedRooms.length })}
                  </button>
                  {endedOpen ? (
                    <ul className="divide-y divide-border">
                      {endedRooms.map((room) => (
                        <li key={room.id}>{roomRow(room)}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </Card>

        {notices.length > 0 && (
          <Card data-testid="zhiyu-notices" title={t("zhiyu.notices.title")}>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {notices.map((n) => {
                // A broadcast carries a title AND a body, so it gets a block of
                // its own rather than the one-line ambient template every other
                // type uses (broadcast-reaches-zhiyu). Both fields come from the
                // server payload verbatim — the client never re-derives them.
                if (n.type === "broadcast") {
                  return (
                    <li key={n.id} className="space-y-1 border-l border-primary/40 pl-2" data-testid="zhiyu-notice-broadcast">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs uppercase tracking-wide text-primary">
                          {t("zhiyu.notices.broadcastTitle")}
                        </span>
                        <span className="shrink-0 text-xs">{new Date(n.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="text-sm font-medium text-foreground">
                        {String(n.payload?.title ?? "")}
                      </p>
                      {n.payload?.body ? (
                        <p className="whitespace-pre-wrap text-sm">{String(n.payload.body)}</p>
                      ) : null}
                    </li>
                  );
                }
                return (
                  <li key={n.id} className="flex justify-between gap-3">
                    <span className="truncate">
                      {t(`zhiyu.notices.${n.type}`, {
                        room: String(n.payload?.roomTitle ?? ""),
                        from: String(n.payload?.from ?? n.payload?.invitedBy ?? ""),
                      })}
                    </span>
                    <span className="shrink-0 text-xs">{new Date(n.createdAt).toLocaleString()}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {/* A team's own outward address (add-zhiyu-team-account). Sits with
            the rooms because that is where "who can reach us" is decided. */}
        <TeamAccountsCard />
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("zhiyu.createRoom")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="zy-title">{t("zhiyu.form.title")}</Label>
              <Input id="zy-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("zhiyu.form.titlePlaceholder")} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="zy-cap">{t("zhiyu.form.replyCap")}</Label>
                <Input id="zy-cap" type="number" min={1} max={20} value={replyCap} onChange={(e) => setReplyCap(e.target.value)} placeholder={t("zhiyu.form.replyCapPlaceholder")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="zy-budget">{t("zhiyu.form.budget")}</Label>
                <Input id="zy-budget" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t("zhiyu.form.budgetPlaceholder")} />
              </div>
            </div>
            <Button className="w-full" disabled={busy} onClick={() => void create()} data-testid="zhiyu-create-submit">
              {t("zhiyu.form.submit")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
