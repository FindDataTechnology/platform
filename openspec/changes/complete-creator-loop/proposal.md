## Why

供给域的漏斗是「看到 → fork → 改 → **试** → 发布 → 跟新」。`unify-material-market` 把前段收干净了，`add-supply-studio-migration` 把创作面搬进了谦面，fork 深链也在。断的是中间那个**试**：

- `facet/web/src/StudioView.tsx:47` 把 `AgentStudioPage` 套进 MemoryRouter 就完事；`PackDraftsView` 里能搜到的只有 `coverage` / `gateGaps`（发布闸的原始信号），**没有任何试跑**。伞文档 D2 写的是「供给域自有 ephemeral 预览沙箱」——这一版不做沙箱，见 design。
- 于是创作者唯一的验证方式是**发布出去看**。发布了才发现 persona 词不达意、技能装进去不对路，只能再发一版。版本不可改写是好事，但「第一版就是盲发」不是。
- 发布闸的信号本身是散的：覆盖率、工具声明闭包、词表越界、英文覆盖，四条来自不同阶段、以不同形状回报（有的在保存时就抱怨，有的到发布才报），创作者要自己拼。

而「试」的正确归宿是运行域：**执行归壹座，供给域不复制一套运行时**。所以这一版做的是把「试」接上，而不是在供给域造一个假沙箱。

## What Changes

- **发布前一张体检单**：把现存的四类闸（注释层/词表、工具面闭包、语言覆盖、清单结构）汇成 Studio 里的一张清单，每条缺口一行、写明**去哪修**（跳对应字段或技能卡），并明确「A 条待修 / 全部通过，可发布」。发布按钮在有待修项时保持可点但给出同一张单的汇总，不再用一句话概括。
- **一键「装进工作台试用」**：草稿面里一个动作，把**已发布的版本**带到运行域（壹座 chat），带包安装并开一轮对话；返回供给域时状态如实显示「已试用 vN」，不改变发布闸的任何判据。
  - 实施时确认的边界（见 design D3a）：安装只收 `{packId, version}`、清单由服务端回市场取，所以**未发布过的草稿没有可交出的 id**。对这种草稿，动作如实说「先发布一版」——不在供给域造安装旁路，也不给会失败的按钮。
- **不伪造执行**：供给域 MUST NOT 声称自己跑过这个包。没有壹座会话时该动作降级为「去哪里可以试」的说明（与现有部署动作的诚实边界同一套措辞逻辑）。
- **发布后跟新可见**：草稿的「上次发布 vN」与当前编辑内容的关系一眼可见（有未发布改动 / 已与线上一致），避免「改完忘了发」。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `supply-studio`: 新增「发布前单一体检单」与「一试的跨域交接」两条需求；明确供给域不承担执行。
- `pack-marketplace`: 发布闸的拒绝信息 SHALL 以可定位到字段的清单形式呈现，而不是一句汇总——判据与拒绝条件本身不变，只改回报形状。

## Impact

- `web/src/components/packs/PackDraftsView.tsx`（体检单汇总 + 跳转锚点）
- `web/src/pages/AgentStudioPage.tsx`（试用动作与状态）
- `facet/web/src/StudioView.tsx`（跨域 handoff 的目标基址与回来后的状态）
- `web/src/pages/ChatPage.tsx`（一次性 pack 装载参数的消费方，若需要）
- locales 五语（体检单与试用两处文案）
- e2e：`e2e/agent-studio-*.spec.js`、新增 `creator-trial-handoff` 用例
- **不动**：发布闸判据、版本不可变、计费、`/agents` 页签契约、任何执行时行为
