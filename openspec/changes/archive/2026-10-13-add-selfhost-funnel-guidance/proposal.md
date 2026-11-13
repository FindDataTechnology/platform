## Why

F3.1（`docs/facet-market-roadmap.md`）：OSS 版的自部署者打开部署位时，今天吃到的是
内部环境变量名错误（`AGENT_SERVING_RUNNER_URL` 503）——既不解决问题也暴露内部构造。
漏斗的正确承接=诚实告诉自部署者两条路：把包发到官方市场（推荐，零基础设施），或
自建服务栈。官方侧同步打磨外部创作者动线文案。

## What Changes

- **探针**：`GET /api/packs/serving-status` → `{configured}`（runner+registry 双件齐；
  注册在 `/api/packs/:id` 之前防路径捕获）。
- **引导面板**：PackDetailDialog 部署区探针前置——未配置=「把这个功能集部署到官方云」
  面板（市场+创作指南双链+自建说明），部署表单与内部错误双隐藏；503 竞态落同面板。
- **官方侧文案**：MineView 头部补漏斗全链说明（serving 公开包→萬星目录→计量→分成）
  +空态创作指南链接。
- 五语键；OSS 随快照发布（面板即自部署者的漏斗入口）。

## Impact

- gateway+web+facet/web 文案；镜像三面滚；官方实例行为不变（探针=true 原表单）。
- specs：facet-platform 增补自部署引导需求。
