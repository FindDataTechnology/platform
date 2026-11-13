# polish-fusion-details

## Why

Y1 用户验收（2026-10-13 深夜）暴露的融合细节四题：①谦面域点「连接工具市场」
Failed to fetch（registry CORS 白名单缺 facet/萬星源，且含已死的 craw 域）；
②「SaaS 连接（连接器）」命名不符合产品线语言（应为 萬星·连接器）；③应用中心的
「平台应用」区与智能体页应用 tab 双入口重复；④「内置模型」条目归属萬星·词元线
（定位中——来源未见于代码/云目录/registry DB，待用户线索，不在本片改）。

## What Changes

- **registry CORS**（配置修复，无代码）：extra_env/registry.env 白名单改为
  platform+facet+wanxing 三源+管理 IP（craw 死域移除）；已 up -d 重建并 curl
  三源实证 ACAO 回显。
- **命名**：extensions.connector.title 五语改为 萬星·连接器。
- **应用中心收敛**：移除「平台应用」区——应用中心是五线品牌面，嵌入应用唯一
  归宿=智能体页应用 tab；e2e 断言不再渲染该区。

## Capabilities

### Modified Capabilities
- `app-center`: 移除平台应用聚合 requirement（REMOVED delta）；应用中心=纯五线
  品牌发现面。

## Impact

- web/src/pages/AppCenterPage.tsx（删区）、五语 connector 词条、e2e 更新；
  registry 配置（cheap-1 extra_env，已生效）。
