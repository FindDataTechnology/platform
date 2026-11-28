// SP 结算查询（P2 4.6，只读）：GET /sp/settlements 后端如实 501（结算与金蝶
// 往来面同源，挂账）。资金红线 D4：本端零支付操作面 —— 对外付款走金蝶/持牌
// 通道，平台不经手资金；即便将来接入，此页也永远只有只读查询，不出现任何
// 支付/账户操作控件。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { spApi } from "@/pagesets/sp-api-wire";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/payment-view";
const SURFACE = "supply-chain.sp" as const;

export default function SpPaymentViewPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead(() => spApi.settlements({}), ready);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-payment-view-page">
        <PageHeader title="结算查询" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/sp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && read.notImplemented ? <CapabilityUnavailable message={read.notImplementedMessage} /> : null}

            <View className="ue-card" data-testid="sp-payment-redline">
              <Text className="ue-detail-title">资金边界</Text>
              <Text className="ue-note-line">
                本端为只读结算查询：不提供支付、账户、提现或任何资金操作；对外付款由采购方经金蝶或持牌通道执行，平台零资金池、不代收代付、不分账。
              </Text>
              <Text className="ue-note-line">结算进度需与金蝶往来面同源，接入前本页如实显示能力未提供。</Text>
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
