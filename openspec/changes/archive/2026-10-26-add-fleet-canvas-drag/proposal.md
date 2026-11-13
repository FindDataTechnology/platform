# Proposal: add-fleet-canvas-drag

## Why

驾驶舱 v2 画布的布局是纯自动分层,节点不可拖动——与 n8n 式「自己排布工作区」的预期落差最大;用户没法把高频关注岗拖到顺手的位置。

## What Changes

- 画布节点可拖拽(读态与设计态均可,拖动只改本机视口排布,不改任何声明数据)。
- 拖动后的节点位置按舰队持久化到浏览器本地(localStorage,键含 fleetId);新岗位无存档位置时落自动分层种子;浏览器清存或换设备回退自动布局,零后端改动。
- 画布图例行增「恢复自动布局」按钮:清空该舰队的本地位置存档并回落分层种子。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-cockpit`: ADDED——节点可拖拽排布,位置按舰队持久化于本机,可一键恢复自动布局;持久化仅影响本机视口排布,不进入舰队声明数据。

## Impact

- 代码:`web/src/components/fleet/FleetCanvas.tsx`(受控节点+onNodesChange/onNodeDragStop+localStorage 读写+重置按钮)、`web/src/pages/FleetsPage.tsx`(传 fleetId)、i18n 五语言一键。
- 非目标:位置不入库(不同设备不同步)、不做连线拖拽编辑(设计模式已有)、不自动保存视口缩放。
