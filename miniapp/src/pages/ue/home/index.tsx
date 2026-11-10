// UE 订货首页（pageset supply-chain.ue 的 home，openspec P1 2.1）。
// 三段面：页面集入口（useVisiblePagesets 同一授权面，本页面集可达页）、
// 检索/分类入口、可购商品卡（api-contract §1 同源检索面）。
// 守卫：整页包 <PagesetGate>，授权未就绪渲染空、未授权弹说明并弹回。

import { useEffect, useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate, useVisiblePagesets } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type ProductCard } from "@/pagesets/erp-api";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/home";

/** 本页面集可达页入口（除 home 自身），注册表顺序。 */
function selfEntries(
  visible: Array<{ def: { key: string }; pages: Array<{ id: string; path: string; title: string }> }>,
): Array<{ path: string; title: string }> {
  const ue = visible.find((p) => p.def.key === "supply-chain.ue");
  if (!ue) return [];
  return ue.pages.filter((p) => p.path !== PAGE_PATH).map((p) => ({ path: p.path, title: p.title }));
}

export default function UeHomePage() {
  const router = useRouter();
  const visible = useVisiblePagesets();
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [categories, setCategories] = useState<Array<{ categoryId?: string; product_count?: number }>>([]);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [keyword, setKeyword] = useState("");

  const load = () => {
    setState({ loading: true, error: null });
    Promise.all([ueApi.products({ limit: 6 }), ueApi.productCategories()])
      .then(([prods, cats]) => {
        setProducts(prods.data ?? []);
        setCategories(cats.data ?? []);
        setState({ loading: false, error: null });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "读取失败" }));
  };

  useEffect(load, []);

  // 深链 keyword（share/检索回跳）带出检索面。
  useEffect(() => {
    const kw = (router.params.keyword ?? "").trim();
    if (kw) Taro.navigateTo({ url: `/pages/ue/product-search?keyword=${encodeURIComponent(kw)}` });
  }, [router.params.keyword]);

  const entries = selfEntries(visible);
  const openProduct = (id?: string) => {
    if (id) Taro.navigateTo({ url: `/pages/ue/product-detail?productId=${encodeURIComponent(id)}` });
  };
  const search = () => {
    const kw = keyword.trim();
    Taro.navigateTo({ url: `/pages/ue/product-search${kw ? `?keyword=${encodeURIComponent(kw)}` : ""}` });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-home-page">
        <PageHeader title="订货首页" />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            <View className="ue-search-row">
              <Input
                className="ue-input"
                placeholder="搜索商品名称 / 编码"
                value={keyword}
                onInput={(e) => setKeyword(e.detail.value)}
                onConfirm={search}
              />
              <Text className="ue-search-btn" onClick={search}>
                搜索
              </Text>
            </View>

            {entries.length > 0 ? (
              <View className="ue-entry-grid" data-testid="ue-home-entries">
                {entries.map((e) => (
                  <Text
                    key={e.path}
                    className="ue-entry"
                    data-testid="ue-home-entry"
                    onClick={() => Taro.navigateTo({ url: `/${e.path}` })}
                  >
                    {e.title}
                  </Text>
                ))}
              </View>
            ) : null}

            {categories.length > 0 ? (
              <View className="ue-chip-row">
                {categories.slice(0, 6).map((c) => (
                  <Text
                    key={c.categoryId}
                    className="ue-chip"
                    onClick={() =>
                      Taro.navigateTo({ url: `/pages/ue/product-search?categoryId=${encodeURIComponent(c.categoryId ?? "")}` })
                    }
                  >
                    {c.categoryId} · {c.product_count ?? 0}
                  </Text>
                ))}
              </View>
            ) : null}

            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? (
              <ErpStateLine text={state.error} tone="error" />
            ) : null}
            {!state.loading && !state.error && products.length === 0 ? (
              <ErpStateLine text="暂无可购商品（商品池未授权或为空）" />
            ) : null}

            <View className="ue-product-grid">
              {products.map((p) => (
                <View key={p.productId} className="ue-product-card" data-testid="ue-home-product" onClick={() => openProduct(p.productId)}>
                  <Text className="ue-product-title">{p.title ?? p.productId}</Text>
                  <Text className="ue-product-meta">{p.category ?? ""}</Text>
                  <Text className="ue-product-price">¥{fmtAmount(p.list_price)}</Text>
                </View>
              ))}
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
