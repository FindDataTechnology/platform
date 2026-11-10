// CP 运单跟踪（P3 5.6）：GET /cp/waybills（列表）+ GET
// /cp/waybills/{id}/events（事件流 + 只读适配器轨迹）。
// 与客户侧全单物流视图同源（交付编排事件档，零平行取数）；轨迹不可得时
// 如实置空，不伪造节点。

import { useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { cpApi } from "@/pagesets/cp-api-wire";
import { type CpEventsData, type CpWaybillRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { waybillStatusText } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/track";
const SURFACE = "supply-chain.cp" as const;

export default function CpTrackPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useSurfaceRead(() => cpApi.waybills({ limit: 50 }), ready);
  const events = useSurfaceRead<CpEventsData>(() => cpApi.waybillEvents(openId ?? ""), ready && !!openId, openId);

  const rows: CpWaybillRow[] = list.data?.data ?? [];
  const ev = events.data;

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-track-page">
        <PageHeader title="运单跟踪" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/cp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && list.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && list.error ? <ErrorLine error={list.error} /> : null}
            {ready && !list.loading && !list.error && rows.length === 0 ? <ErpStateLine text="暂无运单" /> : null}

            {!openId ? (
              <View className="ue-list" data-testid="cp-track-list">
                {rows.map((w) => (
                  <View key={w.waybillId} className="ue-row-card" data-testid="cp-track-row" onClick={() => setOpenId(w.waybillId ?? "")}>
                    <View className="ue-row-main">
                      <Text className="ue-product-title ue-mono">{w.waybill_no ?? w.waybillId}</Text>
                      <Text className="ue-product-meta">
                        {waybillStatusText(w.status)} · 订单 {w.order_ref ?? "—"}
                      </Text>
                    </View>
                    <Text className="ue-row-action">轨迹</Text>
                  </View>
                ))}
              </View>
            ) : (
              <View className="ue-card" data-testid="cp-track-detail">
                <Text className="ue-detail-title ue-mono">{ev?.waybill_no ?? openId}</Text>
                {events.loading ? <ErpStateLine text="加载中…" /> : null}
                {events.error ? <ErrorLine error={events.error} /> : null}
                {ev ? (
                  <>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">状态</Text>
                      <Text className="ue-kv-val">{waybillStatusText(ev.status)}</Text>
                    </View>
                    <Text className="ue-note-strong">事件流（{ev.events?.length ?? 0}）</Text>
                    {(ev.events ?? []).length === 0 ? <ErpStateLine text="暂无事件" /> : null}
                    {(ev.events ?? []).map((e, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 行集无稳定 id（本地草稿行/服务端行数组），只读渲染且顺序即身份
                      <View key={`${e.record}-${e.ref}-${i}`} className="ue-kv">
                        <Text className="ue-kv-key">{e.record ?? ""}</Text>
                        <Text className="ue-kv-val">
                          {e.event ?? ""} · {e.status ?? ""}
                          {e.requested_by ? ` · ${e.requested_by}` : ""}
                        </Text>
                      </View>
                    ))}
                    <Text className="ue-note-strong">适配器轨迹</Text>
                    {ev.track_events && ev.track_events.length > 0 ? (
                      ev.track_events.map((t, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: 行集无稳定 id（本地草稿行/服务端行数组），只读渲染且顺序即身份
                        <View key={i} className="ue-kv">
                          <Text className="ue-kv-key">{String(t.at ?? "")}</Text>
                          <Text className="ue-kv-val">
                            {String(t.status ?? "")} {String(t.note ?? "")}
                          </Text>
                        </View>
                      ))
                    ) : (
                      <ErpStateLine text="适配器未返回轨迹（如实置空，不伪造节点）" />
                    )}
                    {ev.caliber_note ? <Text className="ue-note-line">{ev.caliber_note}</Text> : null}
                    <Text className="ue-link-btn" onClick={() => setOpenId(null)}>
                      返回列表
                    </Text>
                  </>
                ) : null}
              </View>
            )}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
