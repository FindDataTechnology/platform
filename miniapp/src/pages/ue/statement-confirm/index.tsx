// UE 对账单确认（P1 2.2 确认门页，api-contract §4）：
// 列表 → 明细（单据级勾对，行项目带订单与取价 provenance）→ 确认/异议。
// 确认/异议是确认门动作：四段式由 ConfirmGate 承载；服务器回执如实为
// proposal_status=pending（进内核确认门待拍板）——不假报「已确认落账」。
// 异议须附说明，进入内部处置车道。

import { useEffect, useState } from "react";
import { ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type Statement } from "@/pagesets/erp-api";
import { ErpStateLine } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import {
  disputeFormError,
  fmtAmount,
  statementDecisionBody,
  statementReceiptText,
  statementStatusText,
  submitStatementFlow,
} from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/statement-confirm";

export default function UeStatementConfirmPage() {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Statement | null>(null);
  const [disputeMode, setDisputeMode] = useState(false);
  const [disputeNote, setDisputeNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "已提交", icon: "none" });
    },
  });

  useEffect(() => () => gate.dispose(), [gate]);

  const load = () => {
    setState({ loading: true, error: null });
    ueApi
      .statements({})
      .then((res) => {
        setStatements(res.data ?? []);
        setState({ loading: false, error: null });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "读取失败" }));
  };

  useEffect(load, []);

  const open = (id: string) => {
    setOpenId(id);
    setReceipt(null);
    setDisputeMode(false);
    setDisputeNote("");
    setLocalError(null);
    ueApi
      .statementDetail(id)
      .then(setDetail)
      .catch((e: Error) => Taro.showToast({ title: e.message || "读取失败", icon: "none" }));
  };

  const submit = () => {
    if (gate.isPending() || !openId) return;
    setLocalError(null);
    if (disputeMode) {
      const err = disputeFormError(disputeNote);
      if (err) {
        setLocalError(err);
        return;
      }
    }
    submitStatementFlow(gate, {
      confirmStatement: (body) => ueApi.confirmStatement(openId, body),
      body: statementDecisionBody(disputeMode ? "disputed" : "confirmed", disputeNote),
      onConfirmed: (result) => setReceipt(statementReceiptText(result as Parameters<typeof statementReceiptText>[0])),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-statement-page">
        <PageHeader title="对账单确认" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}
            {!state.loading && !state.error && statements.length === 0 ? (
              <ErpStateLine text="本期没有待核对的对账单" />
            ) : null}

            {!openId ? (
              <View className="ue-list" data-testid="ue-statement-list">
                {statements.map((s) => (
                  <View key={s.statement_id} className="ue-row-card" data-testid="ue-statement-row" onClick={() => open(s.statement_id ?? "")}>
                    <View className="ue-row-main">
                      <Text className="ue-product-title">{s.period ?? ""} 对账单</Text>
                      <Text className="ue-product-meta">
                        {s.order_count ?? 0} 笔订单 · {statementStatusText(s.status)}
                      </Text>
                    </View>
                    <Text className="ue-product-price">
                      ¥{fmtAmount(s.amount_total)} {s.currency ?? ""}
                    </Text>
                  </View>
                ))}
                <Text className="ue-note-line">对账单数据与金蝶往来面同源（连接器拉取、中台计算）；金蝶侧拉取挂账见服务说明。</Text>
              </View>
            ) : (
              <View className="ue-card" data-testid="ue-statement-detail">
                <Text className="ue-detail-title">{detail?.period ?? openId} 对账单</Text>
                <View className="ue-kv">
                  <Text className="ue-kv-key">金额</Text>
                  <Text className="ue-kv-val">
                    ¥{fmtAmount(detail?.amount_total)} {detail?.currency ?? ""}
                  </Text>
                </View>
                <View className="ue-kv">
                  <Text className="ue-kv-key">状态</Text>
                  <Text className="ue-kv-val">{statementStatusText(detail?.status)}</Text>
                </View>
                <View className="ue-kv-block">
                  {(detail?.orders ?? []).map((o) => (
                    <View key={String(o.order_ref ?? "")} className="ue-kv">
                      <Text className="ue-kv-key ue-mono">{String(o.order_ref ?? "")}</Text>
                      <Text className="ue-kv-val">¥{fmtAmount(o.amount_total as string)}</Text>
                    </View>
                  ))}
                </View>

                {receipt ? (
                  <View className="ue-kv-block" data-testid="ue-statement-receipt">
                    <Text className="ue-note-line ue-note-strong">{receipt}</Text>
                  </View>
                ) : (
                  <>
                    {disputeMode ? (
                      <Textarea
                        className="ue-textarea"
                        placeholder="请描述对账差异（异议须附说明）"
                        value={disputeNote}
                        onInput={(e) => setDisputeNote(e.detail.value)}
                        maxlength={300}
                      />
                    ) : null}
                    {disputeMode ? (
                      <Text
                        className="ue-link-btn"
                        onClick={() => {
                          setDisputeMode(false);
                          setLocalError(null);
                          gate.clearError();
                        }}
                      >
                        返回确认
                      </Text>
                    ) : (
                      <Text
                        className="ue-link-btn"
                        data-testid="ue-statement-dispute-toggle"
                        onClick={() => {
                          setDisputeMode(true);
                          setLocalError(null);
                          gate.clearError();
                        }}
                      >
                        有差异？发起异议
                      </Text>
                    )}
                    <ConfirmGate
                      api={gate}
                      onSubmit={submit}
                      submitLabel={disputeMode ? "提交异议" : "确认对账单"}
                      pendingLabel="提交中…"
                      error={localError}
                      className="ue-cta"
                      pendingClassName="ue-cta-disabled"
                      errorClassName="ue-error-line"
                      testId="ue-statement-submit"
                      errorTestId="ue-statement-error"
                    />
                    <Text className="ue-note-line">
                      {disputeMode
                        ? "异议进入内部处置车道；对账单状态标为异议处置中。"
                        : "确认经确认门提交内核核对；落账前对账单不记已确认。"}
                    </Text>
                  </>
                )}
                <Text className="ue-link-btn" onClick={() => setOpenId(null)}>
                  返回列表
                </Text>
              </View>
            )}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
