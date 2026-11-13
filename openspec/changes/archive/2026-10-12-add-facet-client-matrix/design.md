# Design — add-facet-client-matrix（F2.2）

## Decisions

### D1 — 矩阵的每一格都有出处
「CLI 写什么」=代码事实（SKILLS_SUBDIR/MCP_TARGETS）；「客户端认什么」=F2.1 实证或
诚实标注（cursor=配置面实证）。矩阵脚注给出口径，不出现无出处的新能力格。

### D2 — 冒烟不碰真键
预置哑 wgk 凭据文件（写入路径不验键——验活只在 connect）；断言形状不断言连通
（连通=F2.1 的 initialize 探针域，属 ad-hoc）。生产 facet 只读 GET。

### D3 — #/docs 矩阵从 cliFacts 派生
能力表进 cliFacts.ts（FACET_CLIENT_CAPABILITIES），DocsView 渲染表——与命令表同源
纪律（漂移=单测红）。深文档矩阵由快照脚本随仓发布。

## Risks / Trade-offs

- 客户端能力随版本漂移（cursor 技能目录已知随版本而异）——矩阵注明「以 CLI 写入形状
  为准，客户端读取面见各指南实证节」；冒烟脚本定期跑=CLI 侧防漂移。
