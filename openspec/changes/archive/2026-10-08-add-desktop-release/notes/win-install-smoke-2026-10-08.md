# Windows 安装冒烟实录（task 4.2，2026-10-08，GitHub windows-latest runner）

## 结论：v1.3.1 Windows 包有打包闭包缺陷，beta 翻转不做，待修复后重跑冒烟

## 冒烟通道（可复用）

私仓 Actions 被账单阻断期间，用**公开仓 FindDataTechnology/platform 的免费
windows-latest runner** 跑真安装冒烟：workflow = `.github/workflows/win-install-smoke.yml`
（私仓留档 + 公开仓 50b52f1），`workflow_dispatch` 传 release tag → 下载已发布
exe → NSIS 静默安装（`/S`，per-user，装到
`%LOCALAPPDATA%\Programs\platform\`）→ 两阶段验证。

## 两阶段判定面

- **Phase A（过）**：启动安装的 Platform.exe → 3 分钟内出现
  `resources\node\node.exe` 子进程 = Electron 壳正常拉起 bundled 后端。
- **Phase B**：从 `resources\app\`（asar:false 布局，app 代码在那里）用打包
  node.exe 直跑 server.js（独立数据目录、47611 端口），等 `/api/ready` 200。

## 三轮探针迭代（探针自身坑，留档防复踩）

1. `WorkingDirectory=安装根` 跑 server.js → `Cannot find module`（app 代码不在根）。
2. 以为有 asar → `resources\app.asar` 不存在（config 是 `asar:false`）。
3. 用 mac 产物核实布局：`Resources/app/server.js` —— asar:false 时 app 代码在
   `resources/app/`。修正后 server 正常监听。

## Phase B 抓到的产品缺陷（真因）

打包 server **listen 成功**（log: `Platform listening at http://localhost:3000`），
随后：

```
TransportClosedError: JSON-RPC transport closed
spawn error: spawn dsh ENOENT
```

- `dsh-bridge.js:26`：`COMMAND = process.env.DSH_BIN || "dsh"` —— dsh **可执行
  本体**（`@deepseek-ai/dsh` npm 包的 bin）是全局安装
  （`/opt/homebrew/bin/dsh`），**不在 package.json 依赖闭包**。v1.3.0 修复
  （7f59800）补的是 7 个 peer **库**（sdk-client/protocol/session/invariants/
  dsh-llm/cordis/llamaindex），不含 dsh 本体（包里有 dsh-agent/dsh-llm 等
  库件，没有带 bin 的 `@deepseek-ai/dsh`）。
- **mac 冒烟通过是本机污染假绿**：dev 机 PATH 有全局 dsh，Electron 继承 PATH；
  干净 Windows 裸机没有。教训与 7f59800 的"必须离开仓库树跑"同族——本机
  PATH 污染同样制造假绿。
- 连带：`server.js:738` `await Promise.all([documentsInit, dshInit])` —— agent
  init 失败直接炸掉整个 server，违背 listen-first 注释承诺（静态/REST 面本
  应"chat non-functional 但服务活着"，stderr 也确实先打了这句然后崩了）。
- 另：Phase B 里 `DESKTOP_SERVER_PORT=47611` 未生效（listen :3000）——该 env
  名是 electron 侧约定，supervisor 翻译成 `PORT`；直跑 server.js 应设 `PORT`。

## 修复方向（待做，修完重跑本冒烟）

1. 依赖闭包：把 `@deepseek-ai/dsh`（bin 本体）钉进 dependencies，或打包时
   `extraResources` 带上 dsh bin 并给 bridge 设 `DSH_BIN` 指向它。后者更干净
   （不污染 self-host npm start 场景的全局解析）。
2. 韧性：`initDshAgent` 失败不应炸 server —— 降级为 `ctx.ready.dsh=false` +
   状态面板报错（对齐 listen-first 语义）。
3. Windows 冒烟脚本 Phase B 用 `PORT`（非 `DESKTOP_SERVER_PORT`）。

## beta 纪律

spec 场景（installer-distribution / Beta promotion discipline）：Windows 保持
`beta: true`，官网下载带 Beta 标记保持不动 —— 现状即正确，无需任何 snapshot
动作。macOS 已冒烟（beta:false）维持。

---

## 修复轮（2026-10-08 晚，d4cc41d → v1.3.2）

### 修复内容（全部验证过）

1. **dsh 入闭包**：`@deepseek-ai/dsh@0.1.1-rc.2` 进 dependencies（bin.js 是纯 JS
   `#!/usr/bin/env node` 脚本，无原生件）。
2. **bridge 打包感知解析**：`DSH_BIN` > bundle 内 bin.js（`process.execPath`
   直跑——打包态 execPath 即 bundled node，ABI 一致；绕开 Windows .bin 无扩展名
   不可 spawn）> PATH 的 `dsh`（dev）。
3. **overrides 钉 `cordis-plugin-hmr@1.0.16`**：`^1.0.16` 在新装环境解析到
   1.0.19，`registerConfig` API 已移除 → profile boot 即 TypeError（dev 冒烟
   第二轮抓到；全局旧装嵌套 1.0.16 所以一直没炸）。
4. **降级**：`initDshAgent` 失败 → WARN + `ctx.dshInitError`，server 照常服务；
   `/api/ready` 带 `dshInitError`。`scripts/test-dsh-degrade.mjs` 4 用例。

### dev 冒烟证据

- 新解析实跑：ps 实证子进程 = `node .../node_modules/@deepseek-ai/dsh/lib/bin.js --profile platform`
- hmr 断裂轮（修复前）：server **活着**、ready 503、dshInitError 带 TypeError
  栈——降级语义实证。
- 修复后：`runtime ready (volces/deepseek-v4.1-flash)`、`/api/ready 200`。

### 发布事故（已恢复，教训入 memory）

在 dist-opensource/platform（无 .git 的文件树）裸跑 git → 命令全部落到主私仓 →
快照树提交进私仓 + `remote set-url` 把主仓 origin 改指 platform → 双向远端
污染。已按 `git ls-remote` 核对四远端全部回正（私仓 d4cc41d / 公开仓 b0b1c98
快照提交）。发快照自此只用 `--git-dir=/tmp/pub-snap/.git --work-tree=<dist>`
的一次性临时仓。

### v1.3.2

tag 打在公开仓快照提交 b0b1c98 上，release workflow 三矩阵构建中；绿后重跑
win-install-smoke（workflow 已在公开仓），绿 → `release-sync v1.3.2 --dl-live
--prune`（不带 --beta=windows）翻转 beta。
