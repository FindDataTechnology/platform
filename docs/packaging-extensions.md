# 把 MCP 服务器和技能打包进应用

构建安装包（`npm run dist`）或打包应用时，你可以**预装** MCP 服务器、**随包分发**技能，让最终用户首次运行即获得——无需配置、无需编辑 `.env` 或 `mcp.json`。这由仓库根目录的打包清单 `platform.bundle.json` 驱动，它是"一次构建包含什么"的唯一事实来源，并随打包应用一起分发（见 `electron-builder.js` 的 `files:`）。

清单有三个键：`mcpServers`、`skills`，以及控制它们的 `permissions`。

```json
{
  "mcpServers": {},
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill"],
  "permissions": {}
}
```

> **所有消费方都经 `bundle-manifest.js` 里的 `resolveBundle()` 读取此文件**——没人直接解析 JSON。无效清单（坏 JSON、未知顶层键、错误权限键）会让构建脚本失败（`resolveBundle()` 抛 `BundleManifestError`）；运行时走 `resolveBundleSafe()`，记一条警告并回退空默认（无打包扩展），确保损坏的清单绝不阻止应用启动。

---

## 1. 打包一个 MCP 服务器

在 `mcpServers` 下加一项。每项是 name → config 映射，带可选 `enabled` 标志：

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    },
    "my-http-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer secret" },
      "enabled": false
    }
  }
}
```

每项是以下之一：

| 字段 | 类型 | 含义 |
|---|---|---|
| `command` | string | **stdio** server —— 要拉起的二进制（配可选 `args`）。`command` 或 `url` 二选一必填。 |
| `url` | string | **http/SSE** server —— MCP 端点。 |
| `args` | string[] | `command`（stdio）server 的 CLI 参数。 |
| `headers` | object | `url` server 的 HTTP 头（如鉴权）。 |
| `enabled` | boolean | 扩展的播种状态。`false` 以**禁用**状态分发——在 Installed 标签可见，用户手动开启前不生效。默认 `true`。 |

### 首次运行时发生了什么

1. `server.js` 在创建 agent 会话**之前**连接每个启用的清单 server，使其工具加入会话工具白名单（连接失败的 MCP 工具被跳过——绝不致命）。
2. 每项以 `origin: "bundled"` 与其 `enabled` 状态播种进扩展数据库，像任何已安装扩展一样出现在 **Extensions → Installed** 标签。
3. 播种是 INSERT-OR-IGNORE：若用户已编辑或禁用该 server，**用户的改动优先**，跨重启与应用升级保留。

### 规则与坑

- **`mcp.json` 同名优先。** `mcp.json` 是运维的本地配置（已 gitignore）；若同名同时存在，用 `mcp.json` 的配置，打包那份被跳过。
- **锁定与工具作用域** 放在 `permissions` 映射里——见 [第 3 节](#3-权限与锁定)。
- **⚠️ 离线安装：优先用 `url` server 或打包二进制。** 基于 `command` 的 stdio server 按名字拉起，`npx` 包会在**最终用户**首次连接时从 npm registry 下载；真离线环境无 registry 可用。要自包含打包，要么 (a) 用 `url`/http server，要么 (b) 把 server 的 JS 构建进 `resources/` 并让 `command` 指向随应用一起分发的二进制。默认清单尚未打包任何 stdio MCP——这是需要留意的已知限制。

---

## 2. 打包技能

技能是 `skills/<name>/` 下纯 `SKILL.md` 文件（YAML frontmatter `name`/`description` + 正文）。**`skills/` 下每个目录都会自动随安装包分发**（`skills/**` 在 `electron-builder.js` 的 `files:` 里）——清单条目只是把技能标记为 *bundled*，让它在 API 里获得锁定/权限语义。

### 添加新技能

1. 创建 `skills/<my-skill>/SKILL.md`：

```markdown
---
name: my-skill
description: 这个技能做什么、何时使用。一两句话。
---

# My Skill

正文：以 `/skill:my-skill <args>` 调用时 agent 展开并执行的指令。
```

2. 把名字加进清单的 `skills` 数组：

```json
{ "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill", "my-skill"] }
```

### 清单 `skills` 条目的作用

文件技能**不是**数据库行——没有可播种的东西。相反，`GET /api/extensions/skills` 从清单派生扩展元数据：

- `skills` 里的名字报告为 `origin: "bundled"`（对比其他本地技能的 `"file"`），
- 它们的 `locked` / `permissions` 来自 `permissions["skill:<name>"]`，
- **不在**清单里的技能照样工作并分发——只是普通可编辑的文件技能。

---

## 3. 权限与锁定

`permissions` 以 `mcp:<name>` / `skill:<name>` 为键，各带 `{ allow?, deny?, locked? }`：

```json
{
  "permissions": {
    "mcp:memory":        { "locked": true },
    "mcp:my-http-server": { "allow": ["fetch*"], "deny": ["fetch:https://internal*"] },
    "skill:my-skill":    { "locked": true }
  }
}
```

| 键 | 类型 | 含义 |
|---|---|---|
| `locked` | boolean | 使条目**经 API 不可变** —— DELETE / 编辑 / 启用开关返回 400。用于保护打包默认不被移除。 |
| `allow` | string[] | 扩展可调用的工具名 glob。已存储；由后续的 extension-tool-permissions 工作强制执行。 |
| `deny` | string[] | 扩展不可调用的工具名 glob。执行状态同上。 |

---

## 4. 完整示例

分发一个"禁用但可见"的 http MCP、一个锁定的 stdio MCP，以及两个新技能：

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    },
    "corp-gateway": {
      "url": "https://gateway.example.com/mcp",
      "headers": { "Authorization": "Bearer ${CORP_TOKEN}" },
      "enabled": false
    }
  },
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill", "my-skill", "team-skill"],
  "permissions": {
    "mcp:memory":   { "locked": true },
    "skill:team-skill": { "locked": true }
  }
}
```

首次运行结果：`memory` MCP 被连接、播种并锁定；`corp-gateway` 在 Installed 里以禁用状态出现（在 UI 里开启即可，但注意 header 值是清单里的静态字符串——只留在服务端，不进浏览器）；`my-skill` 与 `team-skill` 作为打包技能分发。

> 注意：`${CORP_TOKEN}` **不会**被清单做 env 插值——它就是个字面字符串。把真实 token 放进 `mcp.json`（运维配置）或 secret 注入代理，而不是放进随应用发给每个用户的清单里。优先让 `url` server 指向无需每用户 secret 的端点，或明确说明 `headers` 是写死的。

---

## 5. 构建与验证

```bash
npm run predist   # 构建内置资源（build-node → resources/node，再 verify-bundle）
npm run dist      # electron-builder → 安装包（mac .dmg / win .exe）
```

改完清单后，直接 `npm start` 跑一次本地运行，在 **Extensions → Installed** 标签里确认条目按预期播种（启用/禁用、是否锁定），再出安装包。清单校验失败时构建脚本会直接报错并指出是哪个键。

---

## 6. 运行时参考

| 位置 | 作用 |
|---|---|
| `platform.bundle.json` | 清单（开发时在仓库根，打包后在 `Resources/app/`）。 |
| `bundle-manifest.js` | `resolveBundle()` / `resolveBundleSafe()` —— 唯一解析器；校验、回退。 |
| `server.js` `initAgent()` | 会话创建前连接启用的清单 `mcpServers`；把每项播种进扩展 DB（`origin: "bundled"`，INSERT-OR-IGNORE）。 |
| `server.js` `/api/extensions/*` | 扩展管理 API —— 列表/增/改/删 MCP 配置与自定义技能。锁定的打包条目变更返回 400。 |
| `extension-store.js` | DB 层（`seedMcpServer`、`seedExtensionConfig`）；`origin` / `locked` / `permissions` 列。 |
| `electron-builder.js` | 分发 `platform.bundle.json` + `skills/**`。 |
| 规范 | `openspec/specs/bundle-manifest/spec.md`（正式需求 + 场景）。 |

---

# English

# Packaging MCP servers and skills into the app

When you build an installer (`npm run dist`) or bundle the app, you can **pre-install** MCP servers and **ship** skills so end users get them on first run — no setup, no editing `.env` or `mcp.json`. This is driven by the bundle manifest `platform.bundle.json` at the repo root, the single source of truth for what a build contains, shipped inside the packaged app (see `electron-builder.js` `files:`).

The manifest has three keys: `mcpServers`, `skills`, and the `permissions` that control them.

```json
{
  "mcpServers": {},
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill"],
  "permissions": {}
}
```

> **Every consumer resolves this file through `resolveBundle()` in `bundle-manifest.js`** — nobody parses the JSON directly. An invalid manifest (bad JSON, unknown top-level key, malformed permission key) fails the build scripts (`resolveBundle()` throws `BundleManifestError`); at runtime `resolveBundleSafe()` logs a warning and falls back to the empty defaults (no bundled extensions), so a corrupt manifest never prevents the app from starting.

---

## 1. Packaging an MCP server

Add an entry under `mcpServers`. Each entry is a name → config map, with an optional `enabled` flag:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    },
    "my-http-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer secret" },
      "enabled": false
    }
  }
}
```

Each entry is one of:

| Field | Type | Meaning |
|---|---|---|
| `command` | string | **stdio** server — the binary to spawn (with optional `args`). One of `command` or `url` is required. |
| `url` | string | **http/SSE** server — the MCP endpoint. |
| `args` | string[] | CLI args for a `command` (stdio) server. |
| `headers` | object | HTTP headers for a `url` server (e.g. auth). |
| `enabled` | boolean | Seed state of the extension. `false` ships it **disabled** — visible in the Installed tab, off until the user turns it on. Defaults to `true`. |

### What happens at first run

1. `server.js` connects every enabled manifest server **before** the agent session is created, so their tools join the session tool allowlist (an MCP tool that fails to connect is skipped — never fatal).
2. Each entry is seeded into the extensions DB with `origin: "bundled"` and its `enabled` state, so it shows up in the **Extensions → Installed** tab like any installed extension.
3. Seeding is INSERT-OR-IGNORE: if the user has already edited or disabled that server, **their edits win** and are preserved across restarts and app upgrades.

### Rules and gotchas

- **`mcp.json` wins name collisions.** `mcp.json` is the operator's local config (gitignored); if a name exists in both, the `mcp.json` config is used and the bundled one is skipped.
- **Locking and tool scoping** go in the `permissions` map — see [section 3](#3-permissions-and-locking).
- **⚠️ Offline installs: prefer `url` servers or bundle the binary.** A `command`-based stdio server is spawned by name and, for `npx` packages, must download from the npm registry on the *end user's* first connect. A truly offline install has no registry access. For self-contained packaging either (a) use a `url`/http server, or (b) build the server's JS into `resources/` and point `command` at a binary that ships with the app. Nothing in the default manifest bundles a stdio MCP yet — this is the known limitation to watch.

---

## 2. Packaging skills

Skills are plain `SKILL.md` files (YAML frontmatter `name`/`description` + body) under `skills/<name>/`. **Every directory under `skills/` ships in the installer automatically** (`skills/**` is in `electron-builder.js` `files:`) — the manifest entry only marks the skill as *bundled* so it gets lock/permission semantics in the API.

### To add a new skill

1. Create `skills/<my-skill>/SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does and when to use it. One or two sentences.
---

# My Skill

Body: instructions the agent expands and follows when invoked as `/skill:my-skill <args>`.
```

2. Add its name to the manifest `skills` array:

```json
{ "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill", "my-skill"] }
```

### What the manifest `skills` entry does

File skills are **not** DB rows — there's nothing to seed. Instead, `GET /api/extensions/skills` derives the extension metadata from the manifest:

- names in `skills` are reported with `origin: "bundled"` (vs `"file"` for other local skills),
- their `locked` / `permissions` come from `permissions["skill:<name>"]`,
- skills **not** in the manifest still work and ship — they're just ordinary editable file skills.

---

## 3. Permissions and locking

`permissions` is keyed `mcp:<name>` / `skill:<name>`, each with `{ allow?, deny?, locked? }`:

```json
{
  "permissions": {
    "mcp:memory":        { "locked": true },
    "mcp:my-http-server": { "allow": ["fetch*"], "deny": ["fetch:https://internal*"] },
    "skill:my-skill":    { "locked": true }
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `locked` | boolean | Makes the entry **immutable via the API** — DELETE / edit / enable-toggle return 400. Use to protect bundled defaults from being removed. |
| `allow` | string[] | Tool-name globs the extension may call. Stored now; enforced by the extension-tool-permissions work. |
| `deny` | string[] | Tool-name globs the extension may not call. Same enforcement status. |

---

## 4. Worked example

Ship a disabled-but-visible http MCP, a locked stdio MCP, and two new skills:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    },
    "corp-gateway": {
      "url": "https://gateway.example.com/mcp",
      "headers": { "Authorization": "Bearer ${CORP_TOKEN}" },
      "enabled": false
    }
  },
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill", "my-skill", "team-skill"],
  "permissions": {
    "mcp:memory":   { "locked": true },
    "skill:team-skill": { "locked": true }
  }
}
```

Result on first run: the `memory` MCP is connected, seeded, and locked; `corp-gateway` appears disabled in Installed (turn it on in the UI, but note the header value is a static string from the manifest — server-side only, never the browser); `my-skill` and `team-skill` ship as bundled skills.

> Note: `${CORP_TOKEN}` is **not** env-interpolated by the manifest — it's a literal string. Put real tokens in `mcp.json` (operator config) or a secret-injecting proxy, not in a manifest that ships to every user. Prefer pointing `url` servers at endpoints that don't need per-user secrets, or document that `headers` are baked in.

---

## 5. Build and verify

```bash
npm run predist   # build the bundled resources (build-node → resources/node, then verify-bundle)
npm run dist      # electron-builder → installers (mac .dmg / win .exe)
```

After editing the manifest, run `npm start` once locally and check the **Extensions → Installed** tab to confirm entries seeded as intended (enabled/disabled, locked or not) before cutting an installer. If validation fails, the build scripts error out naming the offending key.

---

## 6. Runtime reference

| Where | What |
|---|---|
| `platform.bundle.json` | Manifest (repo root in dev, inside `Resources/app/` when packaged). |
| `bundle-manifest.js` | `resolveBundle()` / `resolveBundleSafe()` — the only parser; validation, fallback. |
| `server.js` `initAgent()` | Connects enabled manifest `mcpServers` before session creation; seeds each into the extensions DB (`origin: "bundled"`, INSERT-OR-IGNORE). |
| `server.js` `/api/extensions/*` | Extensions management API — list/add/edit/delete MCP configs and custom skills. Locked bundled entries reject mutation with 400. |
| `extension-store.js` | DB layer (`seedMcpServer`, `seedExtensionConfig`); `origin` / `locked` / `permissions` columns. |
| `electron-builder.js` | Ships `platform.bundle.json` + `skills/**`. |
| Spec | `openspec/specs/bundle-manifest/spec.md` (formal requirements + scenarios). |
