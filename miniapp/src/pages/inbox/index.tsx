// 待办页（openspec: owner-inbox）。小程序侧。
//
// 读与 web / 原生客户端同一个聚合端点（GET /api/inbox），同一套动作动词，
// 同一份「批准后果」文本——后果由服务端从各车道回调读取的同一组字段派生，
// 客户端不自行推导。
//
// 三条纪律：
//   1. 就地动作打的是各车道既有端点，绝不新增第二条裁定路径；
//   2. 失败原样回显、提交后等服务器确认，绝不乐观关单（复用确认门语义）；
//   3. 老实例 404 = 诚实缺席（「该实例暂无待办面」），不是空队列。
//
// 小程序无 i18n 运行时，按既有约定直接用中文字面量。diff 渲染能力弱，
// 改动证据以可读文本呈现，动作集合不变。

import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import PageHeader from "@/components/PageHeader";
import { authHeaders, refreshToken } from "@/lib/auth";
import { baseUrl } from "@/lib/config";

interface InboxAction {
  op: string;
  label: string;
  endpoint: string;
  method: string;
  bodyShape: Record<string, string>;
  safe: boolean;
}

interface InboxItem {
  laneId: string;
  itemRef: string;
  originLabel: string;
  title: string;
  severity: string;
  itemType: string;
  bucket: "waiting" | "inflight" | "context";
  submittedAt: number | null;
  consequence: string;
  evidence: Record<string, unknown> | null;
  evaluation?: { status: "passed" | "failed" | "unevaluated"; reason: string | null };
  options?: { value: string; label: string }[];
  recommendation?: string | null;
  actions: InboxAction[];
}

interface InboxLane {
  id: string;
  label: string;
  status: "ok" | "error";
  error?: string;
  items: InboxItem[];
}

interface InboxPayload {
  v: number;
  sampledAt: number;
  lanes: InboxLane[];
  counts: { waiting: number; inflight: number };
}

type Segment = "waiting" | "inflight";

const TYPE_TEXT: Record<string, string> = {
  decision: "拍板",
  "config-change": "配置改动",
  "carrier-change": "承载变更",
  "iteration-chain": "铸版链",
  "input-request": "待填表",
  "skill-candidate": "技能候选",
  "persona-candidate": "人格修订",
  "team-approval": "团队调用",
};

async function request(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<
  { status: number; data: unknown }
> {
  const res = await Taro.request({
    url: baseUrl() + path,
    method: (init.method ?? "GET") as keyof Taro.request.Method,
    header: { "content-type": "application/json", ...authHeaders() },
    data: init.body === undefined ? undefined : init.body,
    dataType: "json",
  });
  if (res.statusCode === 401 && !retried) {
    if (await refreshToken()) return request(path, init, true);
  }
  return { status: res.statusCode, data: res.data };
}

export default function InboxPage() {
  const [payload, setPayload] = useState<InboxPayload | null>(null);
  const [absent, setAbsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [segment, setSegment] = useState<Segment>("waiting");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await request("/api/inbox");
      if (r.status === 404) {
        setAbsent(true);
        setPayload(null);
      } else if (r.status >= 400) {
        setAbsent(false);
        setError(`读取失败（HTTP ${r.status}）`);
      } else {
        setAbsent(false);
        setPayload(r.data as InboxPayload);
      }
    } catch (e) {
      setError((e as Error).message || "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useDidShow(() => {
    void load();
  });

  // 一次处置：提交 → 等服务器回执 → 失败原样回显 → 成功后重拉。
  // 绝不乐观关单：没有服务器确认就不改本地列表（确认门同款语义）。
  const runAction = async (item: InboxItem, action: InboxAction) => {
    const key = `${item.itemRef}:${action.op}`;
    setBusy(key);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {};
      if (action.op === "approve" || action.op === "amend") {
        body.choice = item.recommendation ?? item.options?.[0]?.value ?? "";
      }
      const r = await request(action.endpoint, { method: action.method, body });
      if (r.status >= 200 && r.status < 300) {
        setNotice(`${item.title}：${action.label} 已确认`);
        await load();
      } else {
        const msg = (r.data as { error?: string } | null)?.error ?? `HTTP ${r.status}`;
        setNotice(`${item.title}：${action.label} 未成功 —— ${msg}`);
      }
    } catch (e) {
      setNotice(`${item.title}：${action.label} 未成功 —— ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const items = payload
    ? payload.lanes.flatMap((l) => l.items.filter((i) => i.bucket === segment))
    : [];
  const failedLanes = (payload?.lanes ?? []).filter((l) => l.status === "error");

  return (
    <View className="inbox-page" data-testid="mp-inbox-page">
      <PageHeader title="待办" />
      <View className="command-toolbar">
        <Text className="cron-count">
          {payload ? `等你 ${payload.counts.waiting} · 在途 ${payload.counts.inflight}` : ""}
        </Text>
        <Text className="picker-link" onClick={() => void load()}>
          刷新
        </Text>
      </View>

      <View className="inbox-segments" data-testid="mp-inbox-segments">
        {(["waiting", "inflight"] as Segment[]).map((s) => (
          <Text
            key={s}
            className={`inbox-segment ${segment === s ? "inbox-segment-on" : ""}`}
            data-testid={`mp-inbox-segment-${s}`}
            onClick={() => setSegment(s)}
          >
            {s === "waiting" ? "等你" : "在途"} · {payload ? (s === "waiting" ? payload.counts.waiting : payload.counts.inflight) : 0}
          </Text>
        ))}
      </View>

      {loading && !payload ? (
        <View className="sessions-empty">
          <Text>读取中…</Text>
        </View>
      ) : null}

      {absent ? (
        <View className="sessions-empty" data-testid="mp-inbox-absent">
          <Text>该实例暂无待办面，升级后会亮起来</Text>
        </View>
      ) : null}

      {error ? (
        <View className="sessions-empty">
          <Text>{error}</Text>
        </View>
      ) : null}

      {notice ? (
        <View className="sessions-empty" data-testid="mp-inbox-notice">
          <Text>{notice}</Text>
        </View>
      ) : null}

      {failedLanes.length > 0 ? (
        <View className="sessions-empty" data-testid="mp-inbox-lane-errors">
          {failedLanes.map((l) => (
            <Text key={l.id}>{`${l.label} 读取失败：${l.error ?? ""}`}</Text>
          ))}
        </View>
      ) : null}

      {payload ? (
        <ScrollView scrollY className="command-list">
          {items.length === 0 ? (
            <View className="sessions-empty" data-testid="mp-inbox-empty">
              <Text>{segment === "waiting" ? "现在没有等你处置的事项" : "没有已裁定未闭环的事项"}</Text>
            </View>
          ) : (
            items.map((it) => {
              const approve = it.actions.find((a) => a.op === "approve" || a.op === "accept");
              const reject = it.actions.find((a) => a.op === "reject");
              const other = it.actions.find((a) => a.op !== "approve" && a.op !== "accept" && a.op !== "reject" && a.op !== "amend" && a.op !== "evaluate");
              const evalAction = it.actions.find((a) => a.op === "evaluate");
              return (
                <View key={`${it.laneId}:${it.itemRef}`} className="command-card" data-testid={`mp-inbox-item-${it.itemRef}`}>
                  <View className="command-card-head">
                    <Text className="cron-chip cron-chip-running">{TYPE_TEXT[it.itemType] ?? it.itemType}</Text>
                    <Text className="command-card-title">{it.originLabel}</Text>
                  </View>
                  <Text className="command-card-line">{it.title}</Text>
                  {/* 按钮之前先说后果——这条文案来自服务端，客户端不改写。 */}
                  <Text className="command-card-line inbox-consequence" data-testid={`mp-inbox-consequence-${it.itemRef}`}>
                    {it.consequence}
                  </Text>
                  {it.evaluation && it.evaluation.status !== "passed" ? (
                    <Text className="command-card-line inbox-eval">
                      {it.evaluation.status === "unevaluated" ? "未评测（不视为通过）" : "已评测 · 未通过"}
                      {it.evaluation.reason ? `：${it.evaluation.reason}` : ""}
                    </Text>
                  ) : null}
                  <View className="inbox-actions">
                    {approve ? (
                      <Text
                        className="inbox-btn inbox-btn-primary"
                        data-testid={`mp-inbox-approve-${it.itemRef}`}
                        onClick={() => busy === null && void runAction(it, approve)}
                      >
                        {busy === `${it.itemRef}:${approve.op}` ? "提交中…" : approve.label}
                      </Text>
                    ) : null}
                    {other ? (
                      <Text
                        className="inbox-btn"
                        data-testid={`mp-inbox-action-${other.op}-${it.itemRef}`}
                        onClick={() => busy === null && void runAction(it, other)}
                      >
                        {busy === `${it.itemRef}:${other.op}` ? "提交中…" : other.label}
                      </Text>
                    ) : null}
                    {reject ? (
                      <Text
                        className="inbox-btn inbox-btn-ghost"
                        data-testid={`mp-inbox-reject-${it.itemRef}`}
                        onClick={() => busy === null && void runAction(it, reject)}
                      >
                        {reject.label}
                      </Text>
                    ) : null}
                    {evalAction ? (
                      <Text
                        className="inbox-btn inbox-btn-ghost"
                        data-testid={`mp-inbox-evaluate-${it.itemRef}`}
                        onClick={() => busy === null && void runAction(it, evalAction)}
                      >
                        重跑评测
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}
