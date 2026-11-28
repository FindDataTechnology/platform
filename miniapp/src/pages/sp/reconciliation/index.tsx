// SP 对账单（P2 4.4）：GET /sp/statements 等后端如实 501 —— 契约数据源是
// 金蝶 provider 往来面拉取 + 账本内核计算，金蝶 live 接通挂账中（tasks 3.1）。
// 页面调用后按 501 渲染 CapabilityUnavailable：不显示假对账单、不显示可点的
// 「确认」按钮（确认门必须在金额同源到位后才存在）。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { spApi } from "@/pagesets/sp-api-wire";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/reconciliation";
const SURFACE = "supply-chain.sp" as const;

export default function SpReconciliationPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead(() => spApi.statements({}), ready);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-reconciliation-page">
        <PageHeader title="对账单" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/sp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && read.notImplemented ? <CapabilityUnavailable message={read.notImplementedMessage} /> : null}

            <View className="ue-card">
              <Text className="ue-detail-title">本页说明</Text>
              <Text className="ue-note-line">
                应付对账单需与金蝶往来面同源（连接器拉取、内核计算），金蝶 live 接通尚未完成，故本页不提供对账单与确认动作。
              </Text>
              <Text className="ue-note-line">
                金额同源到位后，确认门沿用与客户端对账同一实现（超时/失败不假报成功；异议进处置车道）。
              </Text>
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
