// CP 月台预约（P3 5.3，契约 §3）：GET /cp/dock-slots 后端如实 501（月台资源
// 主数据归仓库作业编排，未建模）；POST .../dock-reservation 已实现 ——
// slotId 是仓库侧不透明引用（由仓库作业方给出），改约=再预约新时段，
// 取消须带 reservationId。页面把这两件事分得很清楚：不伪造时段目录。

import { useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { cpApi } from "@/pagesets/cp-api-wire";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { dockFormError, submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/dock-reserve";
const SURFACE = "supply-chain.cp" as const;

export default function CpDockReservePage() {
  const router = useRouter();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;

  const [waybillId, setWaybillId] = useState((router.params.waybillId ?? "").trim());
  const [slotId, setSlotId] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [slotDay, setSlotDay] = useState("");
  const [action, setAction] = useState<"reserve" | "cancel">("reserve");
  const [reservationId, setReservationId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  // 可约时段目录：后端如实 501 —— 页面据 notImplemented 渲染能力未提供区块
  const slots = useSurfaceRead(() => cpApi.dockSlots({}), ready);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "已提交", icon: "none" });
    },
  });
  useState(() => () => gate.dispose());

  const submit = () => {
    if (gate.isPending()) return;
    setLocalError(null);
    if (!waybillId.trim()) {
      setLocalError("请填写运单号");
      return;
    }
    if (action === "cancel") {
      if (!reservationId.trim()) {
        setLocalError("取消预约须带 reservationId");
        return;
      }
    } else {
      const err = dockFormError(slotId);
      if (err) {
        setLocalError(err);
        return;
      }
    }
    submitDecisionFlow(gate, {
      perform: () =>
        cpApi.reserveDock(waybillId.trim(), {
          action,
          ...(action === "cancel"
            ? { reservationId: reservationId.trim() }
            : {
                slotId: slotId.trim(),
                ...(warehouse.trim() ? { warehouse: warehouse.trim() } : {}),
                ...(slotDay.trim() ? { slotDay: slotDay.trim() } : {}),
              }),
        }),
      onConfirmed: () =>
        setReceipt(
          action === "cancel"
            ? "月台预约已取消（回执写入交付编排月台车道）。"
            : "月台预约已受理（回执写入交付编排月台车道，与仓库作业编排联动）。",
        ),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-dock-reserve-page">
        <PageHeader title="月台预约" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/cp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && slots.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && slots.error ? <ErrorLine error={slots.error} /> : null}
            {ready && slots.notImplemented ? <CapabilityUnavailable message={slots.notImplementedMessage} /> : null}

            {ready && receipt ? (
              <View className="ue-card" data-testid="cp-dock-receipt">
                <Text className="ue-detail-title">回执</Text>
                <Text className="ue-note-strong">{receipt}</Text>
                <Text className="ue-link-btn" onClick={() => setReceipt(null)}>
                  继续操作
                </Text>
              </View>
            ) : null}

            {ready && !receipt ? (
              <View className="ue-card" data-testid="cp-dock-form">
                <Text className="ue-detail-title">{action === "reserve" ? "预约月台" : "取消预约"}</Text>
                <View className="ue-chip-row">
                  {([
                    ["reserve", "预约/改约"],
                    ["cancel", "取消预约"],
                  ] as const).map(([v, label]) => (
                    <Text
                      key={v}
                      className={`ue-chip${action === v ? " ue-chip-active" : ""}`}
                      data-testid={`cp-dock-action-${v}`}
                      onClick={() => setAction(v)}
                    >
                      {label}
                    </Text>
                  ))}
                </View>
                <Input className="ue-input" placeholder="运单号 / waybillId" value={waybillId} onInput={(e) => setWaybillId(e.detail.value)} />
                {action === "reserve" ? (
                  <>
                    <Input
                      className="ue-input"
                      placeholder="月台时段引用 slotId（仓库侧提供）"
                      value={slotId}
                      onInput={(e) => setSlotId(e.detail.value)}
                    />
                    <Input className="ue-input" placeholder="仓库（可选）" value={warehouse} onInput={(e) => setWarehouse(e.detail.value)} />
                    <Input
                      className="ue-input"
                      placeholder="日期 YYYY-MM-DD（可选）"
                      value={slotDay}
                      onInput={(e) => setSlotDay(e.detail.value)}
                    />
                    <Text className="ue-note-line">
                      可约时段目录当前未提供（月台资源主数据未建模），slotId 由仓库作业方给出；改约=再预约一个新时段。
                    </Text>
                  </>
                ) : (
                  <>
                    <Input
                      className="ue-input"
                      placeholder="预约 id reservationId"
                      value={reservationId}
                      onInput={(e) => setReservationId(e.detail.value)}
                    />
                    <Text className="ue-note-line">只能取消本运单下的预约（服务端按运单归属校验，越域 404）。</Text>
                  </>
                )}
                {localError ? (
                  <Text className="ue-error-line" data-testid="cp-dock-form-error">
                    {localError}
                  </Text>
                ) : null}
                <ConfirmGate
                  api={gate}
                  onSubmit={submit}
                  submitLabel={action === "reserve" ? "提交预约" : "确认取消"}
                  pendingLabel="提交中…"
                  className="ue-cta"
                  pendingClassName="ue-cta-disabled"
                  errorClassName="ue-error-line"
                  testId="cp-dock-submit"
                  errorTestId="cp-dock-gate-error"
                />
              </View>
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
