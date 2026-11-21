# 萬星 · 本地内容发布套件

## What this is

云端生成 + 本地发布的完整闭环：从 VAAS 托管实例拉取租户名下的生成产物（图/视频/图文），在本机完成平台适配、人工确认后经自己的浏览器登录态发布到 10 视频平台 + 11 图文平台。登录态只存本机、平台零保管（见包内 SECURITY-NOTES.md）。发布前必须人工确认。

- Species: pack (plaza category enum v1)
- Official: no



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "萬星 · 本地内容发布套件", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install Bzz9r5rmYPIAitS8Ca33Lw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- fd-vaas-pull-from-cloud — 从 VAAS 托管生成实例拉取租户名下的产物到本机发布目录。三种输入任选其一：谦面调用键（连网关按 owner 过滤）、签名下载 URL（生成响应里带的）、或直接给 asset id + 实例地址。产物自动落 downloads/ 标准目录
- fd-vaas-login — 视频 + 图文平台登录管理页 — 查看各平台登录状态，触发扫码/窗口登录，轮询 QR 码。零依赖 Python stdlib HTTP Server。
- fd-vaas-publish-docs — 把一篇文章/图文一键分发到主流图文平台(知乎、微信公众号、小红书、抖音图文、快手图文、雪球、东方财富号、同花顺财经号、今日头条、百家号、微博)。**只做编排 -- 平台差异化文案/字数/标签/封面 + 内容适配 + 发布记录**。**上游优
- fd-vaas-publish-videos — >

MCP server references (1): vaas-wanxing

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
