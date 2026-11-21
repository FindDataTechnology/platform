# 壹座·智能体素材广场 —— 基础设施说明（zh 镜像见文末）

壹座·智能体素材广场（Yizuo Agent Materials Plaza）是面向人与 AI 的素材总览面。它呈现三件事：平台提供了哪些素材、这些素材如何被供给、此刻有哪些素材在场。

## 供给机制（输入-动作-产出）

| Action | Input | Output | Guarantee |
| ------ | ----- | ------ | --------- |
| 发布 Publish | 功能集 manifest（技能+MCP 引用+角色） | 市场上的一个不可变版本快照 | 版本一经发布不可改写；下架不毁已装快照 |
| 获取 Obtain | 五编辑器 CLI / 壹座内置市场 / 谦面市场页 | 装进运行环境的一份冻结快照 | 安装逐包显式发生；匿名可浏览 |
| 运行 Run | 已装快照 + 用户单元（cell） | 隔离运行中的角色与工具面 | cell 间互不可见；工具白名单收窄上下文 |
| 服务化 Serve | 带服务契约的角色 + 部署者计费键 | A2A 常驻对话服务（独立端点与身份） | 驻留不因闲置回收；调用按量结算 |

## 接入

- 人：壹座 web（https://agent.finddatatech.cloud）、谦面市场（https://agent.finddatatech.cloud/#/packs）、五编辑器 CLI（npx @finddatatechnology/facet install <packId>）。
- AI：本文件、catalog.json、每素材一页的 materials/*.md（稳定地址），以及 A2A 服务端点。

---
zh 镜像：上表即全文；本页自足，不依赖站点其他章节。Provenance: facet market · As of: 2026-11-05
