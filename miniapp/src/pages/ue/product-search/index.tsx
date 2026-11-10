// UE 商品检索（P1 2.1）：与 ue-home 共用同一检索面（api-contract §1 同源），
// 独立路由承载深链搜索（keyword/categoryId 参数）。分页沿服务器 offset
// continuation（total → 加载更多）。

import { useEffect, useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type ProductCard } from "@/pagesets/erp-api";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/product-search";
const PAGE_SIZE = 20;

export default function UeProductSearchPage() {
  const router = useRouter();
  const [keyword, setKeyword] = useState(router.params.keyword ?? "");
  const [categoryId, setCategoryId] = useState(router.params.categoryId ?? "");
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<{ loading: boolean; error: string | null; done: boolean }>({
    loading: true,
    error: null,
    done: false,
  });

  const search = (offset: number, kw: string, cat: string) => {
    setState({ loading: true, error: null, done: false });
    ueApi
      .products({ keyword: kw.trim() || undefined, categoryId: cat || undefined, offset, limit: PAGE_SIZE })
      .then((res) => {
        setProducts((prev) => (offset === 0 ? (res.data ?? []) : [...prev, ...(res.data ?? [])]));
        setTotal(res.total ?? 0);
        const nextOffset = offset + (res.data?.length ?? 0);
        setState({ loading: false, error: null, done: nextOffset >= (res.total ?? 0) });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "检索失败", done: false }));
  };

  // 深链参数只触发首查（mount 一次）；其后检索一律由确认键/搜索键显式发起。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 首查种子=router.params（稳定），显式搜索另行触发
  useEffect(() => {
    search(0, router.params.keyword ?? "", router.params.categoryId ?? "");
  }, []);

  const openProduct = (id?: string) => {
    if (id) Taro.navigateTo({ url: `/pages/ue/product-detail?productId=${encodeURIComponent(id)}` });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-product-search-page">
        <PageHeader title="商品检索" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })} />
        <View className="ue-search-row">
          <Input
            className="ue-input"
            placeholder="搜索商品名称 / 编码"
            value={keyword}
            onInput={(e) => setKeyword(e.detail.value)}
            onConfirm={() => search(0, keyword, categoryId)}
          />
          <Text className="ue-search-btn" onClick={() => search(0, keyword, categoryId)}>
            搜索
          </Text>
        </View>
        {categoryId ? (
          <View className="ue-chip-row">
            <Text
              className="ue-chip"
              onClick={() => {
                setCategoryId("");
                search(0, keyword, "");
              }}
            >
              分类 {categoryId} ✕
            </Text>
          </View>
        ) : null}
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading && products.length === 0 ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}
            {!state.loading && !state.error && products.length === 0 ? <ErpStateLine text="没有匹配的商品" /> : null}

            <View className="ue-list">
              {products.map((p) => (
                <View key={p.productId} className="ue-row-card" data-testid="ue-search-product" onClick={() => openProduct(p.productId)}>
                  <View className="ue-row-main">
                    <Text className="ue-product-title">{p.title ?? p.productId}</Text>
                    <Text className="ue-product-meta">
                      {p.productId} · {p.category ?? ""}
                    </Text>
                  </View>
                  <Text className="ue-product-price">¥{fmtAmount(p.list_price)}</Text>
                </View>
              ))}
            </View>

            {!state.loading && !state.error && products.length > 0 ? (
              <Text className="ue-more-line" data-testid="ue-search-count">
                已显示 {products.length}/{total}
              </Text>
            ) : null}
            {!state.loading && !state.error && !state.done && products.length > 0 ? (
              <Text className="ue-more-btn" onClick={() => search(products.length, keyword, categoryId)}>
                加载更多
              </Text>
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
