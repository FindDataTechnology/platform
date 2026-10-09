// 资源库页(spec: resource-library-ui,小程序侧)。图表用现有的无依赖 canvas 渲染
// 器画,文件走 file-transfer 适配器(原生查看器预览 / 转发到聊天)。数据是
// resources_changed 事件驱动的现拉现取;旧 cell 没有这个接口时整页降级为提示,
// 而不是报错。
//
// 与 cron 页同一约定:小程序无 i18n 运行时,直接中文字面量。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import {
  asOfMoment,
  chartOption,
  chartPeriods,
  defaultPeriodWindow,
  deleteResource,
  filterChartOption,
  refreshBinding,
  renameResource,
  resourceFileUrl,
  staleReasonKey,
  useChatStore,
  type PeriodWindow,
  type Resource,
} from "@platform/core";
import PageHeader from "@/components/PageHeader";
import { drawAllCharts, registerChart } from "@/lib/charts";
import { canPreviewFile, canShareFile, previewStoredFile, shareFileToChat } from "@/lib/file-transfer";
import { formatSize, loadResources, saveErrorText, subscribeResources } from "@/lib/resources";
import { runtime } from "@/lib/runtime";

type Filter = "all" | "chart" | "file";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "chart", label: "图表" },
  { key: "file", label: "文件" },
];

const PERIODS: Array<{ key: PeriodWindow; label: string }> = [
  { key: "6m", label: "近 6 月" },
  { key: "1y", label: "近 1 年" },
  { key: "all", label: "全部" },
];

// 小程序没有 i18n 运行时,过期原因在这里落成中文;服务端只给稳定的 code。
const STALE_REASONS: Record<string, string> = {
  credential: "需要重新登录",
  unreachable: "数据源不可达",
  tool_error: "数据源返回错误",
  unit_mismatch: "单位已变化",
  map_violation: "响应结构已变化",
  allowlist: "该工具未开放刷新",
};

function ageText(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function chartCanvasId(id: string): string {
  return `res-chart-${id}`;
}

function ChartCard({
  resource,
  periodWindow,
}: {
  resource: Resource;
  periodWindow: PeriodWindow;
}) {
  const base = useMemo(() => chartOption(resource), [resource]);
  const option = useMemo(
    () => (base ? filterChartOption(base, periodWindow) : null),
    [base, periodWindow],
  );
  const id = chartCanvasId(resource.id);
  useEffect(() => {
    if (option) registerChart(id, option);
  }, [id, option]);
  // Redraw whenever the option changes: a refresh of a bound chart arrives as a
  // new payload through the resources_changed broadcast → refetch → here.
  useEffect(() => {
    if (!option) return;
    const timer = setTimeout(() => drawAllCharts(), 50);
    return () => clearTimeout(timer);
  }, [option]);

  if (!option) {
    return (
      <View className="res-canvas-fallback">
        <Text>该图表无法渲染</Text>
      </View>
    );
  }
  return (
    <View className="md-chart res-chart">
      <Canvas canvasId={id} id={id} className="md-chart-canvas" />
    </View>
  );
}

// 绑定图表的数据源行:来源 · 截至时间、刷新、过期徽标、数据区间。旧 cell 不发
// bindings 字段(bindings === undefined),整块不渲染 —— 图表照常画,不报错。
function BindingBar({
  resource,
  periodWindow,
  shown,
  onWindow,
  onChanged,
}: {
  resource: Resource;
  periodWindow: PeriodWindow;
  /** 当前区间实际画出来的周期数 —— 让区间的效果可见。 */
  shown: number;
  onWindow: (next: PeriodWindow) => void;
  onChanged: () => void;
}) {
  const bindings = resource.bindings ?? [];
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!bindings.length) return null;

  const binding = bindings[0];
  const asOf = ageText(asOfMoment(binding));
  const reason = staleReasonKey(binding.staleReason);

  const refresh = () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    void refreshBinding(resource.id, binding.id, { trigger: "manual" })
      .then((result) => {
        if (result.ok) {
          const counts = result.counts;
          const moved = counts ? counts.appended + counts.revised + counts.resourced : 0;
          setNotice(moved > 0 ? `已更新 · 新增 ${counts?.appended ?? 0}` : "数据已是最新");
        } else {
          setNotice(reason ? STALE_REASONS[reason] : "刷新失败");
        }
        // 刷新后重新拉取:新 payload 经 resources_changed 广播回到本页,画布重画。
        onChanged();
      })
      .catch((e: Error) => setNotice(e.message || "刷新失败"))
      .finally(() => setBusy(false));
  };

  return (
    <View className="res-bind" data-testid="mp-binding-bar" data-binding-id={binding.id}>
      <View className="res-bind-head">
        <Text className="res-bind-source" data-testid="mp-binding-source">
          {binding.server} · {binding.tool}
          {asOf ? ` · 截至${asOf}` : ""}
        </Text>
        {binding.stale ? (
          <Text className="res-bind-stale" data-testid="mp-binding-stale">
            数据可能已过期{reason ? ` · ${STALE_REASONS[reason]}` : ""}
          </Text>
        ) : null}
      </View>
      <View className="res-bind-actions">
        {binding.refreshable ? (
          <Text className="res-action" data-testid="mp-binding-refresh" onClick={refresh}>
            {busy ? "刷新中…" : "刷新"}
          </Text>
        ) : null}
        {PERIODS.map((entry) => (
          <Text
            key={entry.key}
            className={`res-seg ${periodWindow === entry.key ? "res-seg-on" : ""}`}
            data-testid={`mp-binding-period-${entry.key}`}
            onClick={() => onWindow(entry.key)}
          >
            {entry.label}
          </Text>
        ))}
        <Text className="res-bind-count" data-testid="mp-binding-periods">
          已存 {binding.periods} 个 · 显示 {shown} 个
        </Text>
      </View>
      {notice ? (
        <Text className="res-bind-notice" data-testid="mp-binding-notice">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

export default function ResourcesPage() {
  const sessions = useChatStore((s) => s.sessions);
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<Resource[]>([]);
  const [total, setTotal] = useState(0);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 数据区间按资源记:绑定条与图表是同一页里的兄弟节点,状态放在页级。
  const [windows, setWindows] = useState<Record<string, PeriodWindow>>({});
  const filterRef = useRef<Filter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await loadResources({
      type: filterRef.current === "all" ? undefined : filterRef.current,
    });
    setSupported(result.supported);
    setItems(result.items);
    setTotal(result.total);
    if (result.error) setError(result.error);
    setLoading(false);
  }, []);

  // 每次进入页面 + 收到 resources_changed 都重新拉取(无需手动刷新)。
  useDidShow(() => {
    void load();
  });
  useEffect(() => subscribeResources(() => void load()), [load]);

  const sessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);

  const openSession = (resource: Resource) => {
    if (!resource.sessionId || !sessionIds.has(resource.sessionId)) return;
    if (!runtime.send({ type: "switch_session", id: resource.sessionId })) return;
    Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/chat/index" }) });
  };

  const rename = (resource: Resource) => {
    // Taro 自带的 showModal 类型还没跟上平台新增的 editable/content 字段
    // (基础库 2.17.1+),这里显式收窄结果形状。
    const modal = Taro.showModal({
      title: "重命名",
      editable: true,
      placeholderText: resource.title,
      content: resource.title,
    } as unknown as Parameters<typeof Taro.showModal>[0]) as unknown as Promise<{
      confirm: boolean;
      content?: string;
    }>;
    void modal.then((r) => {
      if (!r.confirm) return;
      const title = (r.content ?? "").trim();
      if (!title || title === resource.title) return;
      void renameResource(resource.id, title)
        .then(() => {
          Taro.showToast({ title: "已重命名", icon: "none" });
          return load();
        })
        .catch((e: Error) => Taro.showToast({ title: e.message || "重命名失败", icon: "none" }));
    });
  };

  const remove = (resource: Resource) => {
    Taro.showModal({
      title: "删除资源",
      content: "删除后无法恢复,确定删除?",
      success: (r) => {
        if (!r.confirm) return;
        void deleteResource(resource.id)
          .then(() => {
            Taro.showToast({ title: "已删除", icon: "none" });
            return load();
          })
          .catch((e: Error) => Taro.showToast({ title: e.message || "删除失败", icon: "none" }));
      },
    });
  };

  const preview = (resource: Resource) => {
    const url = resourceFileUrl(resource);
    if (!url) return;
    Taro.showLoading({ title: "打开中…" });
    previewStoredFile(url, resource.title)
      .then(() => Taro.hideLoading())
      .catch((e: Error) => {
        Taro.hideLoading();
        Taro.showToast({ title: e.message || "无法预览", icon: "none" });
      });
  };

  const share = (resource: Resource) => {
    const url = resourceFileUrl(resource);
    if (!url) return;
    Taro.showLoading({ title: "准备中…" });
    shareFileToChat(url, resource.title)
      .then((ok) => {
        Taro.hideLoading();
        if (!ok) Taro.showToast({ title: "当前环境不支持转发文件", icon: "none" });
      })
      .catch((e: Error) => {
        Taro.hideLoading();
        Taro.showToast({ title: saveErrorText(e) || "转发失败", icon: "none" });
      });
  };

  const cardActions = (resource: Resource) => {
    const alive = Boolean(resource.sessionId && sessionIds.has(resource.sessionId));
    return (
      <View className="res-card-actions">
        {resource.type === "file" ? (
          canPreviewFile(resource.title) ? (
            <Text className="res-action" data-testid="mp-resource-preview" onClick={() => preview(resource)}>
              预览
            </Text>
          ) : null
        ) : null}
        {resource.type === "file" && canShareFile() ? (
          <Text className="res-action" data-testid="mp-resource-share" onClick={() => share(resource)}>
            转发
          </Text>
        ) : null}
        {alive ? (
          <Text className="res-action" data-testid="mp-resource-jump" onClick={() => openSession(resource)}>
            回到会话
          </Text>
        ) : null}
        <Text className="res-action" data-testid="mp-resource-rename" onClick={() => rename(resource)}>
          重命名
        </Text>
        <Text className="res-action res-action-danger" data-testid="mp-resource-delete" onClick={() => remove(resource)}>
          删除
        </Text>
      </View>
    );
  };

  return (
    <View className="res-page" data-testid="mp-resources-page">
      <PageHeader title="资源" />
      <View className="res-toolbar">
        {FILTERS.map((f) => (
          <Text
            key={f.key}
            className={`res-seg ${filter === f.key ? "res-seg-on" : ""}`}
            data-testid={`mp-resources-filter-${f.key}`}
            onClick={() => {
              filterRef.current = f.key;
              setFilter(f.key);
              void load();
            }}
          >
            {f.label}
          </Text>
        ))}
        <Text className="res-count">共 {total} 个</Text>
      </View>

      <ScrollView scrollY className="res-list">
        {!supported ? (
          <View className="res-empty" data-testid="mp-resources-unsupported">
            <Text>当前部署尚未提供资源库,升级服务器后即可使用。</Text>
          </View>
        ) : null}
        {supported && loading && items.length === 0 ? (
          <View className="res-empty">
            <Text>加载中…</Text>
          </View>
        ) : null}
        {supported && !loading && items.length === 0 ? (
          <View className="res-empty" data-testid="mp-resources-empty">
            <Text>{error ? error : "还没有资源。对话中生成的图表会自动收进这里;文件可在聊天里点“存入资源”。"}</Text>
          </View>
        ) : null}

        {items.map((resource) => (
          <View
            key={resource.id}
            className="res-card"
            data-testid="mp-resource-card"
            data-resource-id={resource.id}
            data-resource-type={resource.type}
          >
            <View className="res-card-head">
              <Text className="res-card-title">{resource.title}</Text>
              <Text className="res-card-kind">{resource.type === "chart" ? "图表" : "文件"}</Text>
            </View>

            {resource.type === "chart" ? (
              <ChartCard
                resource={resource}
                periodWindow={
                  windows[resource.id] ??
                  defaultPeriodWindow(chartPeriods(chartOption(resource)))
                }
              />
            ) : (
              <Text className="res-card-meta">
                {[resource.fileMime, formatSize(resource.fileSize)].filter(Boolean).join(" · ")}
              </Text>
            )}

            {resource.type === "chart" ? (
              <BindingBar
                resource={resource}
                periodWindow={
                  windows[resource.id] ??
                  defaultPeriodWindow(chartPeriods(chartOption(resource)))
                }
                shown={
                  chartPeriods(
                    filterChartOption(
                      chartOption(resource),
                      windows[resource.id] ??
                        defaultPeriodWindow(chartPeriods(chartOption(resource))),
                    ),
                  ).length
                }
                onWindow={(next) => setWindows((prev) => ({ ...prev, [resource.id]: next }))}
                onChanged={() => void load()}
              />
            ) : null}

            <Text className="res-card-prov">{resource.sessionTitle || ""}</Text>
            {cardActions(resource)}
          </View>
        ))}
        <View className="msg-bottom" />
      </ScrollView>
    </View>
  );
}