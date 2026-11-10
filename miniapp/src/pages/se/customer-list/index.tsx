// SE 客户与线索（P2 3.2）：名下客户列表（GET /se/customers）。
// 归属关系=客户主数据 sales_rep（服务端按 X-ERP-Staff 过滤，越域不可见）。
// 信用列为账本 query_credit 同源；未登记额度的客户如实显示「未登记」，不显示 0。

import { useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeCustomerRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount } from "@/pagesets/ue-view";
import { creditText } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/customer-list";
const SURFACE = "supply-chain.se" as const;

export default function SeCustomerListPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const [keyword, setKeyword] = useState("");
  const [applied, setApplied] = useState("");
  const read = useSurfaceRead(() => seApi.customers({ keyword: applied, limit: 50 }), ready, applied);

  const rows: SeCustomerRow[] = read.data?.data ?? [];

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-customer-list-page">
        <PageHeader title="客户与线索" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready ? (
              <View className="ue-search-row">
                <Input
                  className="ue-input"
                  placeholder="客户名称 / 编码"
                  value={keyword}
                  onInput={(e) => setKeyword(e.detail.value)}
                  onConfirm={() => setApplied(keyword.trim())}
                />
                <Text className="ue-search-btn" onClick={() => setApplied(keyword.trim())}>
                  搜索
                </Text>
              </View>
            ) : null}

            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && !read.loading && !read.error && rows.length === 0 ? (
              <ErpStateLine text="名下暂无客户（归属关系按客户主数据 sales_rep 判定）" />
            ) : null}

            <View className="ue-list" data-testid="se-customer-list">
              {rows.map((c) => (
                <View
                  key={c.customerId}
                  className="ue-row-card"
                  data-testid="se-customer-row"
                  onClick={() => Taro.navigateTo({ url: `/pages/se/customer-detail?customerId=${encodeURIComponent(c.customerId ?? "")}` })}
                >
                  <View className="ue-row-main">
                    <Text className="ue-product-title">{c.name ?? c.customerId}</Text>
                    <Text className="ue-product-meta">
                      {c.code ?? ""} · {c.credit_available === null || c.credit_available === undefined ? "未登记信用额度" : `可用 ${fmtAmount(c.credit_available)}`}
                    </Text>
                    <Text className="ue-product-meta">
                      未结对账 {c.open_statement_count ?? 0} · 应收 {c.ar_balance === null || c.ar_balance === undefined ? "—" : fmtAmount(c.ar_balance)}
                    </Text>
                  </View>
                  <Text className="ue-row-action">详情</Text>
                </View>
              ))}
            </View>

            {ready && read.data ? (
              <Text className="ue-note-line">
                共 {read.data.total} 家（本页 {rows.length}）{read.data.truncated ? " · 结果被截断，请细化搜索" : ""}
              </Text>
            ) : null}
            <Text className="ue-note-line">
              {creditText({}, "信用额度与账本 query_balance 同源（账本计算）：")}
            </Text>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
