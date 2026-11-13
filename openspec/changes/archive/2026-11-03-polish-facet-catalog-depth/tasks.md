## 1. locale 接线（数据语言跟随切换器）

- [x] 1.1 `McpCatalog.tsx` 两处 fetch 带 `?locale=`：列表（:90）与深度（:157）取 `useLanguage().locale`，`locale` 入 useEffect deps 触发切换重取；验证：组件测试——切换 zh→en 后 fetch URL 含 `locale=en` 且重取发生
- [x] 1.2 i18n 新键五语齐上（`mcp.depth.groupOther`/`filterPlaceholder`/`expand`/`collapse`/`noResults`）；验证：五语言文件全齐 + en 门过

## 2. 深度页工具区重排

- [x] 2.1 前缀分组：按工具名 `_` 前首段归组，单成员组并入「其他」桶（尾部），组标题带计数；验证：单测——193 工具夹具分组数与桶归属、单成员组并桶、名字无下划线归「其他」
- [x] 2.2 客户端过滤：单文本框对 name+annotation.name+summary includes 匹配（大小写不敏感），跨组收窄，空结果空态行；验证：单测——命中/不命中/大小写/清空还原四态
- [x] 2.3 响应式网格+clamp：`sm:grid-cols-2 xl:grid-cols-3` + 内容列 `max-w-6xl`；description 默认 clamp（约 4 行）+ per-tool 展开/收起，原始 name 恒显（mono 不替换）；验证：组件测试——clamp 态/展开态/无注释工具原文 clamp 态；断言 raw name 始终在 DOM
- [x] 2.4 impeccable Operate 批次验收：桌面（≥1280px）+窄幅（~700px）两档一轮截图，缺陷单批修+至多一轮确认；验证：截图入档案（走查记录），分组/过滤/展开真机眼见

## 3. 收尾

- [x] 3.1 列表页受益核验：locale 修复后列表卡注释随切换器变（无列表布局改动）；验证：组件测试列表卡 locale 两态
- [x] 3.2 finddata 回执补节「wire cell 注释数据拍板」（补策展 or 接受原文，两选项+体量账 193×5×3）；验证：docs diff 落盘
- [x] 3.3 出片走查+台账：facet 镜像通道照纪律出片（判路 fd-build-channel 先行）；生产真机眼见五语切换数据同变 + 193 工具分组过滤；validate --specs 绿后归档
