// SP 发票上传（P2 4.5）：POST/GET /sp/invoices 后端如实 501（中台文件服务与
// 发票查验/勾兑车道未接入，金蝶回写为 contract-only）。页面如实展示，
// 不提供假上传表单（上传面无车道时假装能传，比没有更糟）。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { spApi } from "@/pagesets/sp-api-wire";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/invoice-upload";
const SURFACE = "supply-chain.sp" as const;

export default function SpInvoiceUploadPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead(() => spApi.invoices(), ready);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-invoice-upload-page">
        <PageHeader title="发票上传" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/sp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && read.notImplemented ? <CapabilityUnavailable message={read.notImplementedMessage} /> : null}

            <View className="ue-card">
              <Text className="ue-detail-title">本页说明</Text>
              <Text className="ue-note-line">
                发票上传需要中台文件服务上传契约与查验/勾兑车道，二者尚未接入；金蝶回写当前为契约级（contract-only）。本页不提供上传入口。
              </Text>
              <Text className="ue-note-line">
                届时上传面为「影像 + 结构化要素」双轨，上传件进中台文件服务，不进连接器凭证面（契约 §5 纪律）。
              </Text>
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
