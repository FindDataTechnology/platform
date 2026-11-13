# Tasks: add-pack-tutorials-and-wizard

## 1. Schema 与校验

- [x] 1.1 `lib/pack-manifest.js`：PACK_LIMITS 增 `maxGuideStepTitleChars: 60` / `maxGuideStepBodyChars: 500`；validatePackManifest 校验 guide（恰好 3 步、非空 title/body、长度上限、类型），可缺省；node 直跑单测四例（合法/步数错/超长/缺省）

## 2. 创作者编辑器

- [x] 2.1 `PackDraftsView`：描述下方「使用指南（三步）」折叠区（三组 title/body 输入 + 字数提示），进 draft manifest 保存与发布链；typecheck 绿

## 3. 详情渲染与向导

- [x] 3.1 `PackDetailDialog`：guide 解析链 manifest→模块→无（manifest 规范化为 PackGuide 形状）；指南卡下渲染客户端模块的示例提问（≤4 条只读）
- [x] 3.2 `PackMarketView` 报告浮层页脚：引导语 + 「打开对话」按钮（navigate /chat + 关闭报告）；报告本体不动
- [x] 3.3 五语言 UI 壳文案（向导页脚/示例标题/编辑器三步区）；`check:locales` 绿

## 4. MP 命名同步

- [x] 4.1 miniapp 5 文件 ~10 处：资源库→成果、存入资源→存入成果、工作区→项目；grep 复查无残留旧命名（用户可见串）

## 5. e2e 与门禁

- [x] 5.1 新增用例：guide 合法发布/畸形拒绝（网关发布路径）、编辑器三步保存进 manifest、详情卡 manifest 优先渲染、示例提问外显、报告页脚跳转对话；既有 pack 用例回归；`check:locales`/lint/typecheck/build 绿
- [x] 5.2 受影响 spec 本地定向全绿；快照线推 scs001 CI 全绿

## 6. 上线

- [x] 6.1 标准发布线：快照强推→镜像（image-publish）→relay 实证→GitOps bump→双滚→in-pod 实证→公网冒烟
