# Tasks — add-session-to-preset（Y4 第一刀：会话→我的方案）

## 1. 服务端

- [x] 1.1 custom-presets.js：examples 白名单+校验（可选 ≤3 条 × ≤200 字，超限 400 指明）
- [x] 1.2 preset-pack-bridge.js：examples 透传进 draft（挂载点按校验器实拍：
      serving.card.examples 优先；无 serving 面时的次选在 design 定）
- [x] 1.3 单测：examples 三态（缺省/合法/超限拒收）+桥透传断言

## 2. Web 提炼向导

- [x] 2.1 SessionToPresetDialog：预填（名称=会话标题、persona+组合快照按
      agentPreset 解析）+示例勾选（默认前 3）+保存（既有 POST）+成功「去发布」
- [x] 2.2 ChatSessionMenu 接线 + 五语词条
- [x] 2.3 CustomPresetsPage 编辑器示例编辑（可选字段，复用同校验）
- [x] 2.4 e2e 哨兵：菜单可达→向导预填→保存落账→列表可见；取消不落账

## 3. 上线与收口

- [x] 3.1 全门绿（单测+e2e+lint+build）→ commit → 出片（快照+image.yml 配方）
- [x] 3.2 GitOps 滚+生产实证（in-pod 探针+浏览器眼见留用户）
- [x] 3.3 归档 + roadmap Y4 第一刀标注
