# Tasks: harden-credential-scalar-format

实施仓：`/Users/chengsishi/paas`（平台侧凭据写入器在 `dsh-profile.js`）。

## 1. 写出格式硬化

- [x] 1.1 `dsh-profile.js:350`：凭据写出改为 `yaml.dump(doc, { lineWidth: -1, forceQuotes: true })`
      （`-1` 而非 `0`——design D1，js-yaml 的 `0` 表示「保持在 0 列内」仍会折叠）
- [x] 1.3 收拢第二条写入路径：`agent-runner/compose.js` 的 `YAML_DUMP_OPTS` 补 `forceQuotes`
      ——与并行会话提交 67b813c（`lineWidth: -1`）互补：它覆盖 runner child home 的
      `applyBillingKey`/`applyDeploymentSecrets`，本 change 覆盖 profile 写入器；而 compose.js:231
      本身也调用 `ensureCredentialsStore`，两路径写同一份文件，格式必须一致
- [x] 1.2 确认其余 9 处 `yaml.dump`（settings/mcp/skills/presets/permissions/tool-search/
      chart-bind/user-questions）**不动**——它们不是凭据载体

## 2. 测试

- [x] 2.1 单测：`writeCredentialsStore` 写出后，93 字符 PAT 与 71 字符 sk-* 均为单行
      `name: 'value'`（断言文件中无 `>-`/`|-`/续行缩进）
- [x] 2.2 单测：值语义等价——新格式加载出的 ref 值与输入字节相同（含含特殊字符的 gh_actor）
- [x] 2.3 单测：单行 grep+sed 式取值得完整值（把 spec 的「单行取值」场景钉成可执行断言）
- [x] 2.4 适配并行会话既有测试 `agent-runner/test/credentials-scalar.test.mjs`：其断言用裸值
      正则（`gh_actor:\s*bot@...`），加引号后失配——改为「取该行 + 剥引号 + 等值」，保留其单行不变量
      （同文件另一个测试本就在剥引号，兼容无误）；3/3 绿


## 3. 上线与验证
- [x] 3.1 出片与滚动（2026-10-12/13 实证）：走 `scs001/platform-image-verify`（公开免费线）出片
      sha-5c9f532（真 sha 5f9c37d）→ relay → ccr 实证（skopeo）；平台应用已随 F3.1 在跑该镜像；
      runner 侧本次滚齐：k8s runner-b/c（GitOps db046c3）+ cheap-1 手工容器 `agent-runner-dsh`
      按在册配方重建（显式 `node agent-runner/index.js`）
- [x] 3.2 生产实证（cheap-1 spider-heal 真实 child）：触发一次真 A2A 回合（"收到"回执）令 child 重生
      → `.credentials.yaml` 中 `git_pat: 'github_pat_…'` **单行引号**、无块标量；单行取值法拿到完整
      93 字符值（仅记尾四位 …7zNX）——事故失败模式消除
- [x] 3.3 归档 openspec change（validate --specs 131 passed）
