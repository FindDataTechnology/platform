// ── 类目→线归位展示映射 (add-legacy-pack-rebrand 2.x; spec: pack-category-line-mapping) ──
//
// 兼容层（overhaul-market-catalog-presentation P1 2.2）：分类体系的唯一真源已迁到
// lib/pack-taxonomy.js（线与领域两轴、五语标签、声明顺序）。本模块保留既有的导出
// 签名与语义不变，内部转调，避免既有调用点（gateway/packs.js、publish 面、测试）
// 同时改；新代码 SHALL 直接从 lib/pack-taxonomy.js 取。
//
// 语义（不变）：
//   - packs.db / manifest 的 category 值零迁移（存储不动）；
//   - curation 写入端点仍收原 slug 语义；
//   - 未映射的类目按原样呈现（present-as-is，不猜测归位）；
//   - `company`/`facade` 归 null：由 badge=facade 承担，不进主货架分面；
//   - 映射表部署侧可配（PACK_CATEGORY_LINES=JSON），非法覆盖回落内置表。

export {
  categoryLines,
  lineOf,
  slugsForLine,
  isLineWord,
  facetLinesOf,
} from "./pack-taxonomy.js";

// 缓存重置：两张表的缓存都清（测试在用例间改 env）。
export { _resetTaxonomyCache as _resetCategoryLinesCache } from "./pack-taxonomy.js";
