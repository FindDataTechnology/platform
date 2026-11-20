// UE 商品详情（P1 2.1，api-contract §1 GET /ue/products/{productId}）：
// 规格/取价引擎结果（客户价，带规则链出处）/库存可见性（如实降级）；
// 加行进进货单（POST /ue/cart/lines，行快照为当次取价）。

import { useEffect, useState } from "react";
import { Image, Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type ProductDetail as ProductDetailData } from "@/pagesets/erp-api";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/product-detail";

export default function UeProductDetailPage() {
  const router = useRouter();
  const productId = router.params.productId ?? "";
  const [data, setData] = useState<ProductDetailData | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState<string>("");
  const [addState, setAddState] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });

  useEffect(() => {
    if (!productId) {
      setState({ loading: false, error: "缺少商品参数" });
      return;
    }
    setState({ loading: true, error: null });
    ueApi
      .productDetail(productId)
      .then((d) => {
        setData(d);
        const units = d.units ?? [];
        const base = units.find((u) => u.kind === "base") ?? units[0];
        setUnit(base?.unit ?? "");
        setState({ loading: false, error: null });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "读取失败" }));
  }, [productId]);

  const units = data?.units ?? [];
  const quote = data?.price;
  const stock = data?.stock;

  const addToCart = () => {
    if (addState.pending) return;
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) {
      setAddState({ pending: false, error: "数量须为正数" });
      return;
    }
    setAddState({ pending: true, error: null });
    ueApi
      .addCartLine({ productId, qty: n, unit: unit || undefined })
      .then(() => {
        setAddState({ pending: false, error: null });
        Taro.showToast({ title: "已加入进货单", icon: "none" });
      })
      .catch((e: Error) => setAddState({ pending: false, error: e.message || "加入失败" }));
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-product-detail-page">
        <PageHeader
          title={data?.title ?? "商品详情"}
          onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })}
        />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}

            {data ? (
              <View className="ue-card" data-testid="ue-product-detail">
                {(data.images ?? []).length > 0 ? (
                  <View className="ue-img-row">
                    {(data.images ?? []).slice(0, 3).map((src) => (
                      <Image key={src} className="ue-img" src={src} mode="aspectFill" />
                    ))}
                  </View>
                ) : null}
                <Text className="ue-detail-title">{data.title ?? productId}</Text>
                <Text className="ue-product-meta">
                  {productId} · {data.category ?? ""} · {data.state ?? ""}
                </Text>

                <View className="ue-kv-block">
                  <View className="ue-kv">
                    <Text className="ue-kv-key">挂牌价</Text>
                    <Text className="ue-kv-val">¥{fmtAmount(data.list_price)}</Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">客户价（取价引擎）</Text>
                    <Text className="ue-kv-val ue-price-blue">
                      ¥{fmtAmount(quote?.unit_price)} / {quote?.unit ?? (unit || "件")}
                    </Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">取价出处</Text>
                    <Text className="ue-kv-val">
                      {(quote?.rule_chain ?? []).length > 0
                        ? `规则链 ${quote?.rule_chain?.length} 条（逐规则可溯源）`
                        : (quote?.caliber_note ?? "挂牌价（无适用规则）")}
                    </Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">库存</Text>
                    <Text className="ue-kv-val">
                      {stock?.visible ? `可用 ${fmtAmount(stock.qty_available)}` : (stock?.note ?? "库存不可见")}
                    </Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">单位</Text>
                    <Text className="ue-kv-val">
                      {units.length > 0
                        ? units.map((u) => `${u.unit ?? ""}(${u.kind === "base" ? "基本" : "销售"}×${String(u.rate ?? "1")})`).join(" ")
                        : "—"}
                    </Text>
                  </View>
                </View>

                <View className="ue-form-row">
                  <Text className="ue-form-label">数量</Text>
                  <Input className="ue-input ue-input-qty" type="digit" value={qty} onInput={(e) => setQty(e.detail.value)} />
                  <Text className="ue-form-label">单位</Text>
                  <Text
                    className="ue-chip"
                    onClick={() => {
                      if (units.length < 2) return;
                      const idx = units.findIndex((u) => u.unit === unit);
                      setUnit(units[(idx + 1) % units.length]?.unit ?? unit);
                    }}
                  >
                    {unit || "件"}
                  </Text>
                </View>
                {addState.error ? (
                  <Text className="ue-error-line" data-testid="ue-addcart-error">
                    {addState.error}
                  </Text>
                ) : null}
                <Text
                  className="ue-cta"
                  data-testid="ue-addcart-btn"
                  onClick={addToCart}
                >
                  {addState.pending ? "加入中…" : "加入进货单"}
                </Text>
              </View>
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
