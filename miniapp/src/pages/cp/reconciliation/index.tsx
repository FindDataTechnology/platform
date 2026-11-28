// CP 运费对账（P3 5.7 确认门位；契约 §6）：GET /cp/freight-statements 与
// POST .../confirm 后端如实 501 —— 运费单来自计费规则引擎，按承运商归集与
// 四层穿透溯源需计费 read 工具面扩展。页面如实展示 501，不显示假运费单，
// 也不显示「可确认」按钮（金额未同源时确认门不存在）。
// 计费口径同源：承运端只读确认，永不改计费口径。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { cpApi } from "@/pagesets/cp-api-wire";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/reconciliation";
const SURFACE = "supply-chain.cp" as const;

export default function CpReconciliationPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead(() => cpApi.freightStatements({}), ready);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-reconciliation-page">
        <PageHeader title="运费对账" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/cp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && read.notImplemented ? <CapabilityUnavailable message={read.notImplementedMessage} /> : null}

            <View className="ue-card">
              <Text className="ue-detail-title">本页说明</Text>
              <Text className="ue-note-line">
                运费单来自计费规则引擎（事件驱动 + 日终快照），按承运商归集与「费用项→单据→作业事件→规则版本」四层穿透溯源需计费 read 面扩展，尚未提供。
              </Text>
              <Text className="ue-note-line">
                计费口径由平台规则引擎单一出处决定，承运端只读确认、不改口径；异议届时进处置车道。
              </Text>
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
