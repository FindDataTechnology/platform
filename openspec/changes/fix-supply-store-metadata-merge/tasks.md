# Tasks — fix-supply-store-metadata-merge

## 1. 复现与判据

- [x] 1.1 用现有 `patchMcpServer` 复现「只发一个 metadata 键 → 兄弟键消失」：起一个内存库，写一条带
      `{supported_transports, surface, credential_ref}` 的行，patch `{metadata:{surface:"x"}}`，断言 transports 已丢
      （先把病钉住，再修）
  - 实证：新增 `test-supply-store.mjs` 两条用例（`patch metadata: one key preserves its siblings` /
    `… explicit null deletes exactly that key`），**修复前 2 红**（14 用例 12 绿 2 红），修复后 14/14 全绿
- [x] 1.2 确认修法边界与既有契约不冲突：`patchable` 白名单、`SUPPLY_UNKNOWN_FIELD`、`guardWrite`、审计行、
      `setMcpServerVisibility`（走标量列）都不受影响
  - 实证：既有 11 条用例（写闸三态、未知字段、审计、fail-closed 可见性、投影、目录面、skills、HTTP 面）修复后全绿；
    `setMcpServerVisibility` 仍走标量列 `{visibility, groups}`，不进入 metadata 合并分支

## 2. 实现

- [x] 2.1 `gateway/supply-store.js::patchMcpServer` 把 `metadata` 从整块替换改为按键合并：
      仅当 `fields` 自带 `metadata` 且其值为对象时合并，否则沿用现有整块语义
  - 实现：新增 `mergeMetadataPatch(stored, incoming)`；
    `if (fields && Object.hasOwn(fields, "metadata")) merged.metadata = mergeMetadataPatch(existing.metadata ?? null, fields.metadata)`
- [x] 2.2 显式 `null` 值 = 删键（`Object.hasOwn` 判定「有没有给这个键」，与「给了 null」区分）
  - 实现：`for (const [key, value] of Object.entries(incoming)) { if (value === null) delete out[key]; else out[key] = value; }`
- [x] 2.3 合并结果保持 `metadata` 为对象（空对象写 `{}` 而不是 `null`），避免下游把 `{}` 与「无 metadata」混判
  - 实现：`base` 非对象时取 `{}`，合并结果恒为对象；「整列置空」只由 `fields.metadata === null` 触发

## 3. 测试（正例 + 反证）

- [x] 3.1 `scripts/test-supply-store.mjs` 新增四类断言：单键保留兄弟键 / 显式 null 删键 / `metadata:null` 整列清空 /
      非对象 metadata 整块替换
  - 实证：`node --test scripts/test-supply-store.mjs` → **14 tests / 14 pass / 0 fail**
- [x] 3.2 反向验证：把合并临时改回 `{...existing, ...fields}` → 3.1 的「单键保留兄弟键」必须转红；改回即绿
  - 实证：临时改成 `merged.metadata = fields.metadata` → **正是那 2 条转红**（12 绿 2 红）；改回 → 14/14 绿
- [x] 3.3 既有 `node --test scripts/test-supply-store.mjs` 全绿（含 fail-closed visibility、投影形状、HTTP 面用例）
  - 实证：同上，11 条既有用例修复前后均绿

## 4. 收口

- [x] 4.1 `openspec validate fix-supply-store-metadata-merge --strict` 绿
  - 实证：`Change 'fix-supply-store-metadata-merge' is valid`
- [x] 4.2 产线回放：拿 `/wire-build-mcp` 的真实 metadata（六个键）做一次 dry-run 合并，确认结果与「全量发送」等价
  - 实证：从脊柱投影取该行真实 metadata（`surface_report_token_hash` 脱敏为 `<redacted>`）→ `/tmp/replay_metadata_merge.mjs`
    起真库、先用真实行 upsert、再只发 `{surface_source:"self_report"}`，与「发全量」对照 → **键集合相同、逐字节相等 → PASS**
- [ ] 4.3 挂账转正：本 change 生效后，`MCP-REGISTRY.md` 里「必须发全量 metadata」的运维纪律降级为「建议」，
      并注明仍有两条例外（整行 upsert 路径；`metadata` 整列置空）
  - **未勾原因**：本条以「本 change 上产」为前提。代码现在只在工作区（未提交、未出片），产线仍跑旧合并语义；
    此时降级运维纪律会让下一次部分补丁再次抹键。出片滚版后补勾。
