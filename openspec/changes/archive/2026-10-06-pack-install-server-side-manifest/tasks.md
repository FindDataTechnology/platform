# Tasks: pack-install-server-side-manifest

## 1. 实现

- [x] 1.1 服务端：`server/routes/packs.js` 安装路由改双形态——body 带 manifest 走原路径；否则以 `{packId, version}` 经市场代理内部通道（facet 基址 + 内部令牌 + 调用者身份）取回 `{id, version, manifest}` 再入 `installPack`；取包失败返回明确错误零写入；复用/抽出市场代理的请求函数保持私有包语义一致
- [x] 1.2 客户端：设置页安装动作改为只 POST `{packId, version}`（移除大 body 组装）
- [x] 1.3 测试：服务端单测/e2e（新形态安装成功、私有包身份语义、取包失败零写入、双形态等价）；跑既有 packs 相关 e2e 回归
- [x] 1.4 构建：`npm run build` + 全量测试绿

## 2. 发布与验证

- [x] 2.1 平台镜像构建 → **三清单同滚**（platform / platform-demo / facet）→ 滚动完成
- [x] 2.2 活链复验（真实浏览器）：安装「数据-自助分析」（曾 100% 被 SQLi 规则拦截）→ My Packs 出现 + 磁盘物化 8 技能；安装「数据-指标工坊」（曾因 `<script` 403）→ 5 技能物化；证据留档
- [x] 2.3 归档：validate --strict → archive；MCP-REGISTRY.md §3 该行销账；记忆更新