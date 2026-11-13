# validate-propose-arg-keys — 任务清单

> 来源：copilot-dock-focused-preset 验收时登记的待修（propose 不校验参数键名）。2026-10-22 用户放行处理。

- [x] 1.1 对上游源码钉每个动作的真实参数名（facet-ops-mcp 双面 / wanxing-ops-mcp / wire-ops-mcp）
       实证：`facet_market_pack_visibility(id, visibility)`、`facet_market_pack_curation(id, category?, featured?)`、
       `facet_market_pack_publish(manifest, packId?)`、`facet_agent_toggle(path, enabled)`；wanxing 四条
       `(pack_id, agent_id[, email | user_id:int])`，deploy 未上游按同约定；`wire_dataset_create(name, csv_content?, columns?)`
       ——原声明 `["name","source"]` 错（`source` 属 `wire_dataset_correct`）。
- [x] 1.2 注册表：19 动作 argKeys+requiredArgs、visibility/curation `packId/pack_id→id` 别名、模板改读规范键、
       `filterKnownArgs` 双向大小写对偶+别名、新增 `validateArgs/argKeysFor/requiredArgsFor`
- [x] 1.3 路由：preflight 之后校验，400 `{error:"invalid args", details, missing, expected}`，不落库
- [x] 1.4 actions-mcp：导入注册表生成 `ARG_SPEC` 进工具 `args` 描述（`*` 必填）；`call()` 把 `details` 拼进错误文本透给模型
- [x] 2.1 单测：`lib/action-registry.test.js` 13/13（新增 4：声明不变量 / 别名归一 / validateArgs / 模板无 undefined）；
       `scripts/test-wire-line-board.mjs` 24/24（新增「缺必填 400 不落库 + 空白即缺失」，两个 approve 用例 propose 体改合法；
       既有「缺凭据+坏体→preflight failed」用例即顺序守卫）；突变验证：删 visibility 别名→红 2，pause 模板回驼峰→红 1
       （精确复现「暂停 agent「undefined」(pack=undefined)」）；全量 `test:unit` 1780/1783——3 红在 `test-layout-storage.mjs`，
       系并行会话在途 `packages/core/src/lib/surfaces.ts` 改动所致（干净 HEAD 同文件 19/19），与本 change 无关
- [x] 3.1 出片随下次 platform 列车；aloadtree 真 cell（`1da519d4c1c0bf89`）+ v2 谦面助手回合级复验「改包可见性」：
       首轮即传对键、`action_proposals` 零垃圾行；萬星线抽验一条 pause 提议落账为 snake_case
       实证（2026-10-23，随舰队列车 sha-a747769/digest dff9387e 上产——fb7c72a6 ⊑ 34b1f89f，platform/platform-demo/facet
       三面同 digest；pod 内三模块 md5 与 origin/main 逐一相等）：
       ① **生产探针**（cell 环回桥 34767）：负例 `{packName,visibility}` → 400 `invalid args` +
       `missing:["id"]` + `expected:["id","visibility"]`、不落库；正例 `{packId,packName,visibility}` → 200，
       落账恰 `{"id":…,"visibility":"private"}`、影响面含 id 无 undefined；wanxing pause 无凭据 → 先给连接卡
       （「缺凭据先于缺参数」顺序生产成立；探针行即时置 expired 清理）。
       ② **真回合**（ego 真机，与上一轮失败验收同指令同包 id 控制变量）：首轮 tool call 原始参数即
       `{"id":"qCEIutJzQd49jnDtV4qeqw","visibility":"private"}`（上一轮同指令三轮才自纠）——ARG_SPEC 描述生效；
       pending 卡面无 undefined；落账规范形；取消零变更；无裸直写工具调用。
       ③ undefined 影响面垃圾行全库 2 条，均为 2026-10-21（修前），滚动后零新增。
       ④ 萬星 pause 生产落账抽验不可达（无 wanxing-caller 凭据，preflight 如实拦）——归一行为由 1.2 单测+突变覆盖。
- [x] 3.2 归档 + 主 spec 同步（`openspec validate --specs` 保持 0 红）
