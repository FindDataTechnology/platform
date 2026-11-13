# Tasks: 记忆线收口

## 1. 智语回合接入 digest 读缝

- [x] 1.1 `server/cluster-memory.js`：`digestLadder` 改为返回 `{block, source}`；新增 `chatMemoryBlockFor(ownerEmail, query, env)`；chat/cluster 包装拼出的 prompt 与改前逐字相同（15 测钉死）
- [x] 1.2 `gateway/zhiyu/room-router.js`：新增 `memoryBlock` 缝与 `promptWithMemory()`，回合 prompt 末尾追加块，任何失败降级开
- [x] 1.3 `gateway/zhiyu/index.js`：默认实现按 `kind=user` 用本人 owner 块、`kind=guest` 恒不注入；开关沿用 `CELL_MEMORY_CHAT_DIGEST`
- [x] 1.4 `scripts/test-zhiyu-room-memory.mjs` 5 测：住户带本人 digest（mint 命名空间=u/<owner>、query=原话）/ 游客零请求且逐字等于无记忆版 / 总闸关断零请求 / fd-memory 挂了回合照答 / 块与 chat 车道逐字节一致

## 2. 成果页手势收口

- [x] 2.1 改 tag 由 `window.prompt` 换行内编辑面（自动聚焦、预填、Enter 存、Esc 撤、保存/取消两键、`,/，` 双分隔、上限 5）
- [x] 2.2 降级态：手势收 503 即 store 记 `memoryOff`，三手势置灰 + 降级说明，成功即清除
- [x] 2.3 `e2e/resources-page.spec.js` 新增两例（行内编辑保存、503 灰态），全文件 14/14 绿
- [x] 2.4 spec 措辞对齐：`resource-library-ui`「弹窗」→「编辑面」并修掉既有两处错字；`memory-portal-ui` 写明降级判据来自 503

## 3. 上产与验收

- [x] 3.1 platform 镜像 sha-b8b592b（源 05cdf4d3）→ ccr digest 38ae73bb → GitOps 68e4427 → ArgoCD 滚版 pod 1/1 Running
- [x] 3.2 生产实证：pod 内真 owner 打真 fd-memory → `source=digest`、块 1292 字含名份引用；总闸与游客路径均空
- [x] 3.3 真机眼见（浏览器）：行内编辑自动聚焦、有存/撤两键、Esc 撤得掉、保存后 `?tags=行内编辑` 命中且值为 `["真机验收","行内编辑"]`
- [x] 3.4 台账 §15.76 落账
